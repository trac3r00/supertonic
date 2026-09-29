#!/usr/bin/env node
import { fetchManifest, inventoryCache, verifyCache } from './cache.mjs';
import { AssetError } from './manifest.mjs';

const usage = `Usage:
  node tools/assets/cli.mjs fetch --manifest <manifest.json> --cache <directory> [--offline]
  node tools/assets/cli.mjs verify --cache <directory> --offline
  node tools/assets/cli.mjs inventory --cache <directory>
`;

function parseArguments(args) {
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') return { command: 'help' };
  const options = new Map();
  while (args.length > 0) {
    const key = args.shift();
    if (!key?.startsWith('--')) throw new AssetError(`unexpected argument: ${key}`);
    if (key === '--offline') {
      if (options.has(key)) throw new AssetError('duplicate option: --offline');
      options.set(key, true);
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith('--') || options.has(key)) throw new AssetError(`missing or duplicate value for ${key}`);
    options.set(key, value);
  }
  return { command, manifest: options.get('--manifest'), cache: options.get('--cache'), offline: options.get('--offline') === true, options };
}

function requireOptions(parsed, allowed, required) {
  for (const key of parsed.options.keys()) {
    if (!allowed.has(key)) throw new AssetError(`unsupported option for ${parsed.command}: ${key}`);
  }
  for (const key of required) {
    if (!parsed.options.has(key)) throw new AssetError(`missing required option: ${key}`);
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === 'help') {
    process.stdout.write(usage);
    return;
  }
  if (parsed.command === 'fetch') {
    requireOptions(parsed, new Set(['--manifest', '--cache', '--offline']), ['--manifest', '--cache']);
    const controller = new AbortController();
    const stop = () => controller.abort(new AssetError('asset fetch interrupted'));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    try {
      const model = await fetchManifest(parsed.manifest, parsed.cache, parsed.offline, controller.signal);
      controller.signal.throwIfAborted();
      process.stdout.write(`${JSON.stringify({ models: [model] })}\n`);
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
    return;
  }
  if (parsed.command === 'verify') {
    requireOptions(parsed, new Set(['--cache', '--offline']), ['--cache']);
    if (!parsed.offline) throw new AssetError('verify requires --offline');
    process.stdout.write(`${JSON.stringify(await verifyCache(parsed.cache))}\n`);
    return;
  }
  if (parsed.command === 'inventory') {
    requireOptions(parsed, new Set(['--cache']), ['--cache']);
    process.stdout.write(`${JSON.stringify(await inventoryCache(parsed.cache))}\n`);
    return;
  }
  throw new AssetError(`unknown command: ${parsed.command}`);
}

main().catch((error) => {
  process.stderr.write(`asset error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
