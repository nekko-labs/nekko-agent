#!/usr/bin/env node
/**
 * The perf harness's world, left running for a person to poke at: the mock
 * model, a scratch data dir with the seeded chats, and the web edition on top.
 *
 *   node scripts/perf/serve.mjs [--port 4392] [--mock-port 4391]
 *
 * Open the printed URL; a prompt containing PERF-STREAM gets the long reply at
 * 300 tok/s. Ctrl+C stops everything and deletes the scratch data dir.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockProvider } from './lib/mock-provider.mjs';
import { seedDataDir } from './lib/seed.mjs';
import { killTree } from './lib/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const port = Number(opt('port', 4392));
const mockPort = Number(opt('mock-port', 4391));

const mock = await startMockProvider({ port: mockPort, tokensPerSecond: 300, replyTokens: 7000 });
const { dir } = seedDataDir({ mockPort, chats: [1000, ...Array(12).fill(400)] });
const server = spawn(process.execPath, [join(ROOT, 'apps/web-app-server/dist/index.js')], {
  cwd: ROOT,
  env: { ...process.env, NEKKO_DATA_DIR: dir, NEKKO_PORT: String(port), NEKKO_HOST: '127.0.0.1' },
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});
console.log(`[perf] scratch data dir ${dir}`);
console.log(`[perf] open http://127.0.0.1:${port}/`);

const stop = async () => {
  killTree(server);
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
