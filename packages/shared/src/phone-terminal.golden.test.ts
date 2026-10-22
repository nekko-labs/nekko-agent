import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { PhoneAccessError, screenPhoneCall } from './phone-access.js';
import {
  phoneSshHostsView,
  phoneTerminalCallArgs,
  phoneTerminalTailView,
  phoneTerminalsView,
} from './phone-terminal.js';

/**
 * The terminal parity fixture the daemon's gate is held to
 * (crates/nekko-remote/tests/golden.rs reads it): how the TS screens a
 * phone's terminal calls, the arguments it forwards, and what the phone
 * receives. Fails when stale; rewrite it with UPDATE_GOLDEN=1.
 */
const file = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote', 'tests', 'golden', 'phone-terminal.json');

const long = 'x'.repeat(300);
const info = (o: Record<string, unknown>) => ({
  id: 'term_1', title: 'zsh', workspaceId: 'w1', cwd: '/Users/philip/code/nekko-agent', shell: '/bin/zsh',
  createdAt: 1760000000000, running: true, sessionId: 's1', ...o,
});

const screens: Array<[string, unknown[]]> = [
  ['terminals:list', [{ sessionId: 's1' }]],
  ['terminals:list', []],
  ['terminals:list', [{}]],
  ['terminals:list', [{ sessionId: '' }]],
  ['terminals:list', [{ sessionId: 's1', workspaceId: 'w1' }]],
  ['terminal:tail', ['term_1']],
  ['terminal:tail', ['term_1', 1024]],
  ['terminal:tail', ['term_1', 10 * 1024 * 1024]],
  ['terminal:tail', ['term_1', 0]],
  ['terminal:tail', ['term_1', 'all']],
  ['terminal:tail', ['']],
  ['ssh:hosts', []],
  ['ssh:hosts', ['ignored']],
  ['terminal:create', [{ sessionId: 's1' }]],
  ['terminal:create', [{ sessionId: 's1', cols: 60, rows: 30, title: 'build' }]],
  ['terminal:create', [{ sessionId: 's1', title: long }]],
  ['terminal:create', [{ sessionId: 's1', cwd: '/etc' }]],
  ['terminal:create', [{ sessionId: 's1', shell: '/bin/sh' }]],
  ['terminal:create', [{ cols: 80 }]],
  ['terminal:create', [{ sessionId: 's1', cols: 0 }]],
  ['terminal:create', [{ sessionId: 's1', rows: 301 }]],
  ['terminal:create', [{ sessionId: 's1', cols: 80.5 }]],
  ['terminal:create', [{ sessionId: 's1', title: 3 }]],
  ['terminal:create', ['s1']],
  ['ssh:open', ['devbox', { sessionId: 's1', cols: 80, rows: 24 }]],
  ['ssh:open', ['devbox', { sessionId: 's1' }]],
  ['ssh:open', ['devbox', { cols: 80 }]],
  ['ssh:open', ['devbox', { sessionId: 's1', workspaceId: 'w1' }]],
  ['ssh:open', ['', { sessionId: 's1' }]],
  ['ssh:open', [long, { sessionId: 's1' }]],
  ['ssh:open', ['devbox']],
  ['terminal:write', ['term_1', 'ls\r', 'tok']],
  ['terminal:write', ['term_1', 'ls\r']],
  ['terminal:write', ['term_1', 'ls\r', '']],
  ['terminal:write', ['term_1', 7, 'tok']],
  ['terminal:write', ['term_1', 'é'.repeat(32 * 1024), 'tok']],
  ['terminal:write', ['term_1', 'é'.repeat(32 * 1024 + 1), 'tok']],
  ['terminal:write', ['', 'ls', 'tok']],
  ['terminal:resize', ['term_1', 100, 40, 'tok']],
  ['terminal:resize', ['term_1', 100, 40]],
  ['terminal:resize', ['term_1', 501, 40, 'tok']],
  ['terminal:resize', ['term_1', 100, 0, 'tok']],
  ['terminal:resize', ['term_1', 'wide', 40, 'tok']],
  ['terminal:resize', ['term_1']],
  ['terminal:signal', ['term_1']],
  ['terminal:signal', ['term_1', 'KILL']],
  ['terminal:close', ['term_1']],
  ['terminal:close', [null]],
  ['terminal:run', ['term_1', 'rm -rf /']],
  ['terminal:update', ['term_1', { title: 'x' }]],
  ['terminal:shells', []],
  ['terminal:snapshot', ['term_1']],
  ['terminal:attach', ['term_1', { id: 'phone-2' }]],
  ['terminal:detach', [null, 'phone-2']],
  ['terminals:list:native', []],
  ['terminal:open', ['term_1']],
];

function screened(channel: string, args: unknown[]) {
  try {
    screenPhoneCall(channel, args);
    return { channel, args, forwarded: phoneTerminalCallArgs(channel, args) };
  } catch (e) {
    if (!(e instanceof PhoneAccessError)) throw e;
    return { channel, args, error: e.message };
  }
}

const terminals = [
  info({}),
  info({ id: 'term_2', title: long, cwd: 'C:\\Users\\philip\\code\\api\\', shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', running: false, exitCode: 0, viewers: [{ id: 'phone-1', kind: 'phone', name: "Philip's iPhone", since: 1 }] }),
  info({ id: 'term_3', title: 'devbox', cwd: '/Users/philip', shell: '/usr/bin/ssh', order: 2 }),
  { id: 'agent_s1', title: 'Agent commands', shell: 'agent', agentSessionId: 's1', cwd: '', running: false, createdAt: 1 },
  info({ id: 'term_4', cwd: '/', shell: '', sessionId: undefined }),
  { title: 'no id' },
  'junk',
];

const tails = [
  { info: info({}), buffer: '\u001b[32m$\u001b[0m ls\r\nREADME.md\r\n', cols: 80, rows: 24, truncated: true, totalBytes: 2048 },
  { info: info({}), buffer: '', cols: 120, rows: 40 },
  { buffer: 'x', cols: 'wide' },
  null,
];

const hosts = [
  [
    { alias: 'devbox', hostName: 'devbox.example.com', user: 'philip', port: 2222 },
    { alias: 'pi', hostName: '192.168.1.20' },
    { alias: 'bare' },
    { alias: '', hostName: 'x' },
    { hostName: 'no-alias' },
    { alias: 'badport', port: 70000 },
    { alias: long, hostName: long, user: 'root', port: 22 },
  ],
  Array.from({ length: 205 }, (_, i) => ({ alias: `h${i}` })),
  { not: 'a list' },
];

function fixture() {
  return {
    screens: screens.map(([c, a]) => screened(c, a)),
    terminals: terminals.map((t) => ({ input: [t], output: phoneTerminalsView([t]) })).concat([{ input: terminals, output: phoneTerminalsView(terminals) }]),
    tails: tails.map((t) => ({ input: t, output: phoneTerminalTailView(t) })),
    hosts: hosts.map((h) => ({ input: h, output: phoneSshHostsView(h) })),
  };
}

it('writes the terminal parity fixture the daemon is held to', () => {
  const want = fixture();
  if (process.env.UPDATE_GOLDEN) writeFileSync(file, `${JSON.stringify(want, null, 1)}\n`);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(want)));
});
