import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetError, loadManifest, sourceUrl } from './manifest.mjs';

const LOCK_WAIT_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new AssetError(message);
}

function isMissing(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function ensureDirectory(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = relative(root, absolute).split('/').filter(Boolean);
  let current = root;
  for (const component of remainder) {
    current = join(current, component);
    const entry = await exists(current);
    if (!entry) {
      await mkdir(current);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`cache path is not a safe directory: ${current}`);
  }
  return absolute;
}

function targetPath(cache, manifest) {
  return join(cache, manifest.model.id, manifest.model.revision);
}

async function streamHash(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function isLfsPointer(path) {
  const handle = await open(path, 'r');
  const prefix = Buffer.alloc(64);
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return prefix.subarray(0, bytesRead).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1');
  } finally {
    await handle.close();
  }
}

async function validateContent(path, file, sampleRate) {
  if (file.kind === 'graph' || file.kind === 'license') return;
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`invalid JSON asset: ${file.path}`);
  }
  if (value === null || typeof value !== 'object') fail(`incompatible JSON asset: ${file.path}`);
  if (file.kind !== 'indexer' && Array.isArray(value)) fail(`incompatible JSON asset: ${file.path}`);
  if (file.kind === 'metadata' && file.path.endsWith('tts.json') && value.ae?.sample_rate !== sampleRate) {
    fail(`sample rate mismatch in ${file.path}`);
  }
  if (file.kind === 'style' && (value.style_ttl === undefined || value.style_dp === undefined || value.metadata === undefined)) {
    fail(`incompatible voice style: ${file.path}`);
  }
}

async function verifyDirectory(directory, manifest) {
  const entry = await exists(directory);
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) fail(`model cache is missing or unsafe: ${directory}`);
  for (const file of manifest.files) {
    const path = join(directory, file.path);
    const fileEntry = await exists(path);
    if (!fileEntry || fileEntry.isSymbolicLink() || !fileEntry.isFile()) fail(`missing or unsafe asset: ${file.path}`);
    const actual = await streamHash(path);
    if (actual.bytes !== file.bytes) fail(`size mismatch for ${file.path}`);
    if (actual.sha256 !== file.sha256) fail(`SHA-256 mismatch for ${file.path}`);
    if (await isLfsPointer(path)) fail(`LFS pointer rejected for ${file.path}`);
    await validateContent(path, file, manifest.model.sampleRate);
  }
}

function fetchTimeout() {
  const requested = Number.parseInt(process.env.ASSETS_FETCH_TIMEOUT_MS ?? '', 10);
  return Number.isSafeInteger(requested) && requested >= 1_000 && requested <= 600_000 ? requested : DEFAULT_FETCH_TIMEOUT_MS;
}

async function fetchToFile(url, path, file, signal) {
  const timeout = AbortSignal.timeout(fetchTimeout());
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) fail(`download failed for ${file.path}: HTTP ${response.status}`);
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) !== file.bytes) fail(`declared size mismatch for ${file.path}`);
  const output = await open(path, 'wx');
  const hash = createHash('sha256');
  const prefix = [];
  let prefixLength = 0;
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > file.bytes) fail(`oversized download rejected for ${file.path}`);
      hash.update(chunk);
      if (prefixLength < 256) {
        const part = Buffer.from(chunk).subarray(0, 256 - prefixLength);
        prefix.push(part);
        prefixLength += part.length;
      }
      await output.write(chunk);
    }
  } finally {
    await output.close();
  }
  if (Buffer.concat(prefix).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) fail(`LFS pointer rejected for ${file.path}`);
  if (bytes !== file.bytes) fail(`truncated download rejected for ${file.path}`);
  if (hash.digest('hex') !== file.sha256) fail(`SHA-256 mismatch for ${file.path}`);
}

async function releaseLock(lock) {
  await unlink(lock).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

async function staleLock(lock) {
  try {
    const data = JSON.parse(await readFile(lock, 'utf8'));
    if (Number.isSafeInteger(data.pid)) {
      try {
        process.kill(data.pid, 0);
        return false;
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ESRCH') {
          await releaseLock(lock);
          return true;
        }
      }
    }
  } catch {
    await releaseLock(lock);
    return true;
  }
  return false;
}

async function acquireLock(cache, manifest, target, signal) {
  const lockDirectory = await ensureDirectory(join(cache, '.locks'));
  const lock = join(lockDirectory, `${manifest.model.id}-${manifest.model.revision}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const existingTarget = await exists(target);
    if (existingTarget) return null;
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return lock;
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      await staleLock(lock);
      await delay(50);
    }
  }
  fail('timed out waiting for concurrent asset fetch');
}

function inventoryFor(manifest, cache) {
  const graphs = manifest.files.filter((file) => file.kind === 'graph');
  const styles = manifest.files.filter((file) => file.kind === 'style');
  return {
    model: manifest.model.id,
    revision: manifest.model.revision,
    cache,
    graphCount: graphs.length,
    styleCount: styles.length,
    graphHashes: graphs.map(({ path, sha256 }) => ({ path, sha256 })),
    styles: styles.map(({ path, sha256 }) => ({ name: path.split('/').pop().replace('.json', ''), sha256 })),
  };
}

export async function fetchManifest(manifestPath, cachePath, offline, signal) {
  signal?.throwIfAborted();
  const manifest = await loadManifest(manifestPath);
  const cache = await ensureDirectory(cachePath);
  const target = targetPath(cache, manifest);
  const existing = await exists(target);
  if (existing) {
    await verifyDirectory(target, manifest);
    return inventoryFor(manifest, target);
  }
  if (offline) fail('offline cache miss');
  const lock = await acquireLock(cache, manifest, target, signal);
  if (lock === null) {
    await verifyDirectory(target, manifest);
    return inventoryFor(manifest, target);
  }
  let stage;
  let published = false;
  try {
    signal?.throwIfAborted();
    const partialRoot = await ensureDirectory(join(cache, '.partial'));
    stage = join(partialRoot, `${manifest.model.id}-${manifest.model.revision}-${process.pid}-${Date.now()}`);
    const targetAfterLock = await exists(target);
    if (targetAfterLock) {
      await verifyDirectory(target, manifest);
      return inventoryFor(manifest, target);
    }
    await mkdir(stage);
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const destination = join(stage, file.path);
      await ensureDirectory(dirname(destination));
      await fetchToFile(sourceUrl(manifest, file), destination, file, signal);
    }
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await verifyDirectory(stage, manifest);
    await ensureDirectory(dirname(target));
    signal?.throwIfAborted();
    await rename(stage, target);
    published = true;
    return inventoryFor(manifest, target);
  } finally {
    try {
      if (!published && stage) await rm(stage, { recursive: true, force: true });
    } finally {
      await releaseLock(lock);
    }
  }
}

async function cachedManifests(cache) {
  const root = await exists(cache);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) fail('cache directory does not exist');
  const models = await readdir(cache, { withFileTypes: true });
  const manifests = [];
  for (const model of models) {
    if (model.name.startsWith('.')) continue;
    if (!model.isDirectory() || model.isSymbolicLink()) fail(`unsafe model cache entry: ${model.name}`);
    const modelDirectory = join(cache, model.name);
    for (const revision of await readdir(modelDirectory, { withFileTypes: true })) {
      if (!revision.isDirectory() || revision.isSymbolicLink()) fail(`unsafe revision cache entry: ${revision.name}`);
      const directory = join(modelDirectory, revision.name);
      const manifestPath = join(directory, 'manifest.json');
      const manifestEntry = await exists(manifestPath);
      if (!manifestEntry || manifestEntry.isSymbolicLink() || !manifestEntry.isFile()) fail(`missing cached manifest: ${directory}`);
      const manifest = await loadManifest(manifestPath);
      if (manifest.model.id !== model.name || manifest.model.revision !== revision.name) {
        fail(`cached manifest identity does not match directory: ${directory}`);
      }
      manifests.push({ directory, manifest });
    }
  }
  if (manifests.length === 0) fail('no cached model manifests found');
  return manifests;
}

export async function verifyCache(cachePath) {
  const cache = resolve(cachePath);
  const manifests = await cachedManifests(cache);
  for (const item of manifests) await verifyDirectory(item.directory, item.manifest);
  return { networkRequests: 0, models: manifests.map(({ directory, manifest }) => inventoryFor(manifest, directory)) };
}

export async function inventoryCache(cachePath) {
  const cache = resolve(cachePath);
  const manifests = await cachedManifests(cache);
  for (const item of manifests) await verifyDirectory(item.directory, item.manifest);
  return { models: manifests.map(({ directory, manifest }) => inventoryFor(manifest, directory)) };
}
