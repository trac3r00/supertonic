import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
const evidence = resolve(process.env.ASSETS_EVIDENCE_DIR);
const work = await mkdtemp(join(evidence, 'ownership-'));
const revision = '0123456789abcdef0123456789abcdef01234567';
const graph = Buffer.from('graph');
const style = Buffer.from('{"style_ttl":{},"style_dp":{},"metadata":{}}');
const files = [['onnx/a.onnx', graph, 'graph'], ['voice_styles/M1.json', style, 'style']];
const server = createServer((request, response) => {
  const item = files.find(([path]) => request.url.endsWith(path));
  response.end(item[1]);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const manifest = { schemaVersion: 1, model: { id: 'fixture-model', revision, sampleRate: 44100 }, source: { baseUrl: `http://127.0.0.1:${server.address().port}/${revision}` }, files: files.map(([path, bytes, kind]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind })) };
const manifestPath = join(work, 'manifest.json');
await writeFile(manifestPath, JSON.stringify(manifest));
const results = [];
function run(args, signal) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ['tools/assets/cli.mjs', ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const interrupt = signal ? setTimeout(() => child.kill(signal), 150) : null;
    const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code, signal) => { clearTimeout(interrupt); clearTimeout(deadline); resolveRun({ code, signal, stdout, stderr }); });
  });
}
try {
  for (const [id, rev] of [['wrong-model', revision], ['fixture-model', 'wrong-revision']]) {
    const cache = join(work, id + rev);
    const directory = join(cache, id, rev);
    for (const [path, bytes] of files) { await mkdir(join(directory, path.split('/')[0]), { recursive: true }); await writeFile(join(directory, path), bytes); }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    for (const command of ['verify', 'inventory']) {
      const result = await run([command, '--cache', cache, ...(command === 'verify' ? ['--offline'] : [])]);
      assert.equal(result.code, 1); assert.match(result.stderr, /identity/); assert.equal(result.stdout, '');
      results.push({ scenario: `${command}/${id}/${rev}`, ...result });
    }
  }
  const cache = join(work, 'shared');
  await mkdir(join(cache, '.locks'), { recursive: true });
  const lock = join(cache, '.locks', `fixture-model-${revision}.lock`);
  const owner = JSON.stringify({ pid: process.pid });
  await writeFile(lock, owner);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const result = await run(['fetch', '--manifest', manifestPath, '--cache', cache], signal);
    assert.equal(result.code, 1); assert.equal(await readFile(lock, 'utf8'), owner);
    results.push({ scenario: `waiting-owner-preserved/${signal}`, ...result });
  }
  await rm(lock);
  assert.equal((await run(['fetch', '--manifest', manifestPath, '--cache', cache])).code, 0);
  assert.equal((await run(['verify', '--cache', cache, '--offline'])).code, 0);
  assert.deepEqual(await readdir(join(cache, '.locks')), []);
  assert.deepEqual(await readdir(join(cache, '.partial')), []);
  await writeFile(join(evidence, 'identity-signal.json'), JSON.stringify(results, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await rm(work, { recursive: true });
  await writeFile(join(evidence, 'ownership-cleanup.json'), JSON.stringify({ removed: work, serverClosed: true }, null, 2));
}
