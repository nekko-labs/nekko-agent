import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { PhoneAccessError, redactPhoneResult, screenPhoneCall } from './phone-access.js';

/**
 * Shared cases for files and logs from a phone (phone-files.ts): how the
 * computer screens a phone's call and what the phone receives back. The
 * daemon's copy (crates/nekko-remote/src/phone_files.rs) is checked against
 * the same file by crates/nekko-remote/tests/golden.rs. UPDATE_GOLDEN=1
 * rewrites it from this TS; without it, this fails when the file is stale.
 */
const path = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote', 'tests', 'golden', 'phone-files.json');

const CHAT = { sessionId: 's1' };
const HASH = 'a'.repeat(64);

const screens: Array<[string, unknown[]]> = [
  ['files:list', [CHAT]],
  ['files:list', [CHAT, 'src']],
  ['files:list', [{ workspaceId: 'w1' }, '']],
  ['files:list', [{ sessionId: 's1', workspaceId: 'w2' }, 'docs']],
  ['files:list', [{}]],
  ['files:list', [{ path: '/etc' }]],
  ['files:list', [{ sessionId: 's1', path: '/' }]],
  ['files:list', [{ sessionId: '' }]],
  ['files:list', ['s1']],
  ['files:list', [CHAT, 3]],
  ['files:list', [CHAT, 'a\u0000b']],
  ['files:list', [CHAT, 'x'.repeat(1025)]],
  ['files:search', [CHAT, 'readme']],
  ['files:search', [CHAT, 'readme', 20]],
  ['files:search', [CHAT, 'readme', 5000]],
  ['files:search', [CHAT, 'readme', 0]],
  ['files:search', [CHAT, 'readme', 2.5]],
  ['files:search', [CHAT, '   ']],
  ['files:search', [CHAT, 'q'.repeat(201)]],
  ['files:read', [CHAT, 'src/main.rs']],
  ['files:read', [CHAT, 'src/main.rs', { maxBytes: 4096 }]],
  ['files:read', [CHAT, 'big.log', { maxBytes: 10_000_000 }]],
  ['files:read', [CHAT, 'a.txt', { maxBytes: 0 }]],
  ['files:read', [CHAT, 'a.txt', { offset: 10 }]],
  ['files:read', [CHAT, '']],
  ['files:read', [CHAT, '.env']],
  ['files:read', [CHAT, 'deploy/.ssh/id_ed25519']],
  ['files:read', [CHAT, '.git/config']],
  ['files:read', [CHAT, 'sub/.git-credentials']],
  ['files:write', [CHAT, 'notes.md', '# Notes\n', { expectHash: HASH }]],
  ['files:write', [CHAT, 'notes.md', '# Notes\n']],
  ['files:write', [CHAT, 'notes.md', '# Notes\n', { expectHash: null }]],
  ['files:write', [CHAT, 'notes.md', '# Notes\n', { expectHash: 'abc' }]],
  ['files:write', [CHAT, 'notes.md', '# Notes\n', { expectHash: HASH, mode: 0o777 }]],
  ['files:write', [CHAT, 'notes.md', 42, { expectHash: HASH }]],
  ['files:write', [CHAT, '.env.local', 'X=1', { expectHash: HASH }]],
  ['files:write', [{ workspaceId: 'w1' }, 'a.txt', '', { expectHash: HASH }]],
  ['logs:list', []],
  ['logs:list', ['extra']],
  ['logs:read', ['daemon']],
  ['logs:read', ['app', { tailBytes: 65_536 }]],
  ['logs:read', ['app', { tailBytes: 50_000_000 }]],
  ['logs:read', ['agent:s1', { query: 'error', tailBytes: 50_000_000, maxMatches: 5000 }]],
  ['logs:read', ['daemon', { query: '' }]],
  ['logs:read', ['daemon', { query: 7 }]],
  ['logs:read', ['daemon', { path: '/var/log/syslog' }]],
  ['logs:read', ['daemon', { maxMatches: -1 }]],
  ['logs:read', ['']],
  ['logs:read', [{ id: 'app' }]],
];

const listing = {
  path: '',
  entries: [
    { name: '.ssh', path: '.ssh', dir: true },
    { name: 'src', path: 'src', dir: true, mtime: 1 },
    { name: '.env', path: '.env', dir: false, size: 10 },
    { name: 'README.md', path: 'README.md', dir: false, size: 120, mtime: 2, link: true, abs: '/home/me/p/README.md' },
    { name: 'key.pem', path: 'key.pem', dir: false, size: 1 },
    'junk',
  ],
  total: 6,
  truncated: false,
  hiddenSecrets: 2,
  hiddenLinks: 1,
  root: '/home/me/p',
};
const many = { path: 'gen', entries: Array.from({ length: 503 }, (_, i) => ({ name: `f${i}`, path: `gen/f${i}`, dir: false, size: i })), total: 503, truncated: false, hiddenSecrets: 0, hiddenLinks: 0 };
const text = {
  path: 'src/main.rs', name: 'main.rs', size: 20, mtime: 5, hash: HASH, kind: 'text', content: 'fn main() {}\n',
  truncated: false, language: 'rust', editable: true, abs: '/home/me/p/src/main.rs',
};

const views: Array<[string, unknown]> = [
  ['files:list', listing],
  ['files:list', many],
  ['files:list', null],
  ['files:search', { hits: [{ path: 'README.md', name: 'README.md' }, { path: 'a/.env', name: '.env' }, { path: 'docs/readme.txt', name: 'readme.txt', score: 3 }], truncated: false, complete: true }],
  ['files:search', { hits: Array.from({ length: 105 }, (_, i) => ({ path: `p${i}`, name: `p${i}` })), truncated: false, complete: false }],
  ['files:search', 'nope'],
  ['files:read', text],
  ['files:read', { path: 'logo.png', name: 'logo.png', size: 9, mtime: 1, hash: HASH, kind: 'image', truncated: false, editable: false, mime: 'image/png', imageDataUrl: 'data:image/png;base64,AAAA' }],
  ['files:read', { path: 'evil.png', name: 'evil.png', size: 9, mtime: 1, hash: HASH, kind: 'image', truncated: false, editable: false, mime: 'image/png', imageDataUrl: 'javascript:alert(1)' }],
  ['files:read', { path: 'a.bin', name: 'a.bin', size: 9, mtime: null, hash: null, kind: 'binary', truncated: false, editable: false }],
  ['files:read', { ...text, path: 'config/.env', name: '.env', content: 'TOKEN=1' }],
  ['files:read', []],
  ['files:write', { ok: true, hash: HASH, size: 8, mtime: 9, path: '/abs' }],
  ['files:write', { ok: false, error: 'conflict', hash: 'b'.repeat(64) }],
  ['files:write', 'ok'],
  ['logs:list', [
    { id: 'app', title: 'Desktop app', kind: 'app', size: 10, updatedAt: 1, path: '/Users/me/Library/logs/app.log' },
    { id: 'daemon', title: 'Engine', kind: 'daemon', size: 0, updatedAt: null },
    { id: 'agent:s1', title: 'Fix it', kind: 'agent', size: 5, updatedAt: 2, sessionId: 's1' },
    7,
  ]],
  ['logs:list', Array.from({ length: 125 }, (_, i) => ({ id: `agent:s${i}`, title: `c${i}`, kind: 'agent', size: 1, updatedAt: i, sessionId: `s${i}` }))],
  ['logs:list', { logs: [] }],
  ['logs:read', { id: 'daemon', size: 30, updatedAt: 3, truncated: false, text: 'line one\nline two\n', path: '/x' }],
  ['logs:read', { id: 'app', size: 30, updatedAt: 3, truncated: true, query: 'err', matches: [{ line: 4, text: 'error one', extra: 1 }, { line: 9, text: 'z'.repeat(2100) }, 'bad'], moreMatches: false }],
  ['logs:read', { id: 'app', size: 30, updatedAt: 3, truncated: false, query: 'e', matches: Array.from({ length: 502 }, (_, i) => ({ line: i + 1, text: 'e' })), moreMatches: false }],
  ['logs:read', null],
];

function screenCase(channel: string, args: unknown[]) {
  try {
    return { channel, args, callArgs: screenPhoneCall(channel, args).callArgs ?? null };
  } catch (e) {
    if (!(e instanceof PhoneAccessError)) throw e;
    return { channel, args, error: e.message };
  }
}

it('writes the files and logs cases the daemon is held to', () => {
  const golden = {
    screens: screens.map(([c, a]) => screenCase(c, a)),
    views: views.map(([channel, result]) => ({ channel, result, view: redactPhoneResult(channel, result) ?? null })),
  };
  // One case per line: reviewable, without the bulk of an indented file.
  const lines = (list: unknown[]) => list.map((c) => JSON.stringify(c)).join(',\n');
  const out = `{"screens":[\n${lines(golden.screens)}\n],"views":[\n${lines(golden.views)}\n]}\n`;
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, out);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(out));
});
