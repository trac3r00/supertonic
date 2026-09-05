import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const sources = join(root, 'tools/contracts/unicode/sources');
const files = ['normalization.json', 'grapheme.json', 'unicode-manifest.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function cli(output, source = sources, verify = true) {
  const args = ['run', '--python', '3.11', 'tools/contracts/unicode/generate.py', '--sources-dir', source, '--output-dir', output];
  if (verify) args.push('--verify-output');
  const result = spawnSync('uv', args, { cwd: root, encoding: 'utf8' });
  console.log(JSON.stringify({ command: ['uv', ...args], exit: result.status, stdout: result.stdout, stderr: result.stderr }));
  assert.ifError(result.error);
  return result;
}
function scratch(body) {
  const dir = mkdtempSync(join(tmpdir(), 'task1b-fix1-'));
  try { body(dir); } finally {
    rmSync(dir, { recursive: true });
    assert.equal(existsSync(dir), false);
    console.log(JSON.stringify({ cleanup: dir, removed: true }));
  }
}
function copyTables(dir) {
  for (const file of files) cpSync(join(root, 'contracts/v1', file), join(dir, file));
}
const mutations = [
  ['mapping-U+00A0', 'normalization.json', table => { table.decomposition_mappings.find(row => row[0] === 160)[1] = [33]; }],
  ['CCC', 'normalization.json', table => { table.canonical_combining_classes.find(row => row[0] === 769)[1] = 1; }],
  ['Hangul', 'normalization.json', table => { table.hangul.s_base += 1; }],
  ['grapheme', 'grapheme.json', table => { table.properties.Extended_Pictographic[0][2] = 'No'; }],
];
for (const [name, file, mutate] of mutations) {
  test(`reject rehashed ${name} without rewriting artifacts`, () => scratch(dir => {
    copyTables(dir);
    const table = read(join(dir, file));
    mutate(table);
    write(join(dir, file), table);
    const manifest = read(join(dir, 'unicode-manifest.json'));
    manifest.generated_files[file] = hash(readFileSync(join(dir, file)));
    write(join(dir, 'unicode-manifest.json'), manifest);
    const before = files.map(item => hash(readFileSync(join(dir, item))));
    const result = cli(dir);
    assert.deepEqual(files.map(item => hash(readFileSync(join(dir, item)))), before);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unicode 15\.1 fidelity mismatch/);
  }));
}
test('preserve stale hash rejection', () => scratch(dir => {
  copyTables(dir);
  writeFileSync(join(dir, 'normalization.json'), '{}');
  const result = cli(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /stale generated file/);
}));
test('reject wrong source lock even with valid artifacts', () => scratch(dir => {
  copyTables(dir);
  const copied = join(dir, 'sources');
  cpSync(sources, copied, { recursive: true });
  const lock = read(join(copied, 'source-lock.json'));
  lock.sources.find(item => item.file === 'UnicodeData.txt').sha256 = '0'.repeat(64);
  write(join(copied, 'source-lock.json'), lock);
  const result = cli(dir, copied);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source digest mismatch/);
}));
test('fresh generation twice equals checked-in bytes and verifies read-only', () => scratch(dir => {
  for (const name of ['a', 'b']) {
    const output = join(dir, name);
    assert.equal(cli(output, sources, false).status, 0);
    assert.equal(cli(output).status, 0);
    for (const file of files) assert.deepEqual(readFileSync(join(output, file)), readFileSync(join(root, 'contracts/v1', file)));
  }
}));
