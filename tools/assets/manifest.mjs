import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

export class AssetError extends Error {}

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message) {
  throw new AssetError(message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function safeRelativePath(path) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail(`unsafe asset path: ${path}`);
  }
  return path;
}

function validateSource(source, revision) {
  if (!plainObject(source)) fail('manifest source must be an object');
  const baseUrl = requiredString(source.baseUrl, 'source.baseUrl');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail('source.baseUrl must be a URL');
  }
  const localTestSource = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localTestSource) fail('source.baseUrl must use HTTPS outside loopback tests');
  if (!url.pathname.endsWith(`/${revision}`)) fail('source.baseUrl must pin the declared immutable revision');
  if (url.pathname.includes('/main')) fail('source.baseUrl must not reference mutable main');
  return { baseUrl: url.toString().replace(/\/$/, '') };
}

function validateFile(raw, seen) {
  if (!plainObject(raw)) fail('manifest file entry must be an object');
  const path = safeRelativePath(requiredString(raw.path, 'file.path'));
  if (seen.has(path)) fail(`duplicate asset path: ${path}`);
  seen.add(path);
  const bytes = raw.bytes;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_FILE_BYTES) fail(`invalid asset size for ${path}`);
  const sha256 = requiredString(raw.sha256, `file SHA-256 for ${path}`);
  if (!SHA256.test(sha256)) fail(`invalid SHA-256 for ${path}`);
  const kind = requiredString(raw.kind, `file kind for ${path}`);
  if (!['graph', 'metadata', 'indexer', 'style', 'license'].includes(kind)) fail(`unsupported asset kind for ${path}`);
  const onnx = raw.onnx;
  if (kind === 'graph' && onnx !== undefined && !plainObject(onnx)) fail(`invalid ONNX schema for ${path}`);
  return { path, bytes, sha256, kind, ...(onnx === undefined ? {} : { onnx }) };
}

export function validateManifest(raw) {
  if (!plainObject(raw)) fail('manifest must be a JSON object');
  if (raw.schemaVersion !== 1) fail('unsupported manifest schemaVersion');
  if (!plainObject(raw.model)) fail('manifest model must be an object');
  const id = requiredString(raw.model.id, 'model.id');
  const revision = requiredString(raw.model.revision, 'model.revision');
  const sampleRate = raw.model.sampleRate;
  if (!MODEL_ID.test(id)) fail('model.id contains unsupported characters');
  if (!REVISION.test(revision)) fail('model.revision must be a 40-character lowercase commit SHA');
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) fail('model.sampleRate must be a positive integer');
  const source = validateSource(raw.source, revision);
  if (!Array.isArray(raw.files) || raw.files.length === 0) fail('manifest files must be a non-empty array');
  const seen = new Set();
  const files = raw.files.map((file) => validateFile(file, seen));
  const graphCount = files.filter((file) => file.kind === 'graph').length;
  const styleCount = files.filter((file) => file.kind === 'style').length;
  if (graphCount === 0 || styleCount === 0) fail('manifest requires graph and style assets');
  return {
    schemaVersion: 1,
    model: { id, revision, sampleRate },
    source,
    files,
  };
}

export async function loadManifest(path) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`cannot read manifest ${basename(path)}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return validateManifest(raw);
}

export function sourceUrl(manifest, file) {
  const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
  return new URL(`${manifest.source.baseUrl}/${encodedPath}`).toString();
}
