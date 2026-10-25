import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { artifactAccess, chatLinks, localPath, loopbackUrl } from './chat-links.js';
import { PhoneAccessError, redactPhoneResult, screenPhoneCall } from './phone-access.js';

/**
 * Shared cases for what the agent linked, opened on a phone (#1095;
 * chat-links.ts, phone-artifacts.ts): which links a chat has, how a path or
 * URL is normalised, which paths those links open, how the gate screens a
 * phone's call and what the phone receives. The daemon's copies
 * (crates/nekko-remote/src/chat_links.rs, phone_artifacts.rs) are checked
 * against the same file by crates/nekko-remote/tests/golden.rs.
 * UPDATE_GOLDEN=1 rewrites it from this TS; without it, this fails when stale.
 */
const path = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote', 'tests', 'golden', 'phone-artifacts.json');

const say = (content: string) => ({ role: 'assistant', content });

const links: Array<[unknown, string | null]> = [
  [[say('Made [the report](reports/out.md) and ![chart](chart.png).')], '/home/me/p'],
  [[say('[Report](reports/out.md)')], null],
  [[say('See [it](/tmp/a/index.html) and [again](/tmp/a/./b/../index.html)')], null],
  [[say('[win](C:\\Users\\me\\out\\report.html) [url](file:///C:/Users/me/My%20Docs/plan.md)')], null],
  [[say('[mac](file:///Users/me/Desktop/a%20b.pdf) [host](file://localhost/tmp/x.svg) [unc](file://server/share/x.md) [short](file:/tmp/y.txt)')], null],
  [[say('[bad escape](file:///tmp/%E0%A4%A.md) [query](file:///tmp/q.html?x=1#top) [frag](/tmp/f.md#part)')], null],
  [[say('[remote](https://example.com/a.md) [mail](mailto:a@b.md) [js](javascript:alert(1).md) [data](data:text/html,x.html) [unc](\\\\srv\\s\\a.md) [proto](//cdn/a.md)')], '/p'],
  [[say('[exe](/tmp/a.exe) [noext](/tmp/README) [ads](C:/x/a.md:secret.md) [ctl](/tmp/a\u0001.md)')], null],
  [[say('```\n[fenced](/tmp/fenced.md) http://localhost:1111\n```\n`[inline](/tmp/inline.md)` and `http://localhost:2222`\n[real](/tmp/real.md)')], null],
  [[say('Unclosed ```\n[gone](/tmp/gone.md) http://localhost:3333')], null],
  [[say('[up](../../../../etc/x.md) [drive](C:/../../x.md)')], '/home/me'],
  [[say('Running at http://localhost:5173/ and http://127.0.0.1:5173/app, also http://0.0.0.0:5173.')], null],
  [[say('[app](http://localhost:3000/index.html) https://localhost/ HTTP://LOCALHOST:8080 http://[::1]:9000/x')], null],
  [[say('Not ours: http://localhost.example.com/ http://localhost@example.com http://localhost:99999 http://localhost:0 http://127.0.0.1.nip.io http://localhost:80a http://localhostx')], null],
  [[say('Edge: (http://localhost:4000) <http://localhost:4001> "http://localhost:4002" http://localhost:4003, http://localhost')], null],
  [[{ role: 'user', content: '[mine](/tmp/user.md) http://localhost:7000' }, { role: 'tool', content: '[t](/tmp/tool.md)' }, say('[a](/tmp/a.md)'), say('[A again](/tmp/a.md) http://localhost:5173'), 'junk', { role: 'assistant', content: 5 }], null],
  [[say('Not loopback: http://localhosté/ http://localhost%2Eevil/ http://localhost:80.evil/ http://localhost\\evil/')], null],
  ['not a list', '/p'],
  [[say('[label [nested](/tmp/n.md) x](/tmp/outer.md) [multi\nline](/tmp/m.md) [empty]() [sp](< /tmp/angle.md >)')], null],
];

const paths: string[] = [
  '/tmp/a.md',
  'C:\\Users\\me\\a.html',
  'c:/Users/me/../me/./a.html',
  'file:///C:/Users/me/a%20b.png',
  'file:///home/me/a.css?v=2',
  'file://localhost/home/me/x.js',
  'file://evil/home/x.js',
  'file:relative.md',
  'relative/a.md',
  '',
  '/',
  '/../../etc/passwd',
  'https://example.com/a.md',
  '\\\\server\\share\\a.md',
  '//server/share/a.md',
  'C:/a.md:stream',
  '/tmp/a\u0000.md',
  '/tmp/a%20b.md',
];

const urls: string[] = [
  'http://localhost:5173/',
  'http://localhost:5173',
  'HTTP://LocalHost:5173/A?b=C#frag',
  'https://127.0.0.1/app',
  'http://0.0.0.0:8080/x',
  'http://[::1]:9000/',
  'http://localhost:5173?x=1',
  'http://user@localhost:5173/',
  'http://localhost.example.com/',
  'http://example.com/',
  'ftp://localhost/',
  'http://localhost:0/',
  'http://localhost:65536/',
  'http://localhost:/',
  'http://localhost:12a/',
  'http://localhosté/',
  'http://[::1]é/',
  'http://localhost /x',
  'http://localhost\\x',
  'http://[::2]:80/',
  `http://localhost/${'a'.repeat(2048)}`,
];

const LINKS = {
  artifacts: ['/home/me/p/out/index.html', '/home/me/p/notes.md', 'C:/Users/Me/Out/Report.HTML', '/page.html', 'C:/root.htm'],
  origins: ['http://localhost:5173'],
};

const access: Array<[string, boolean]> = [
  ['/home/me/p/out/index.html', false],
  ['/home/me/p/notes.md', false],
  ['/home/me/p/NOTES.md', false],
  ['/home/me/p/NOTES.md', true],
  ['/home/me/p/out/app.js', false],
  ['/home/me/p/out/assets/deep/font.woff2', false],
  ['/home/me/p/out/data.json', false],
  ['/home/me/p/out/run.exe', false],
  ['/home/me/p/out/app.wasm', false],
  ['/home/me/p/out/.git/config.json', false],
  ['/home/me/p/out/.hidden.css', false],
  ['/home/me/p/other.css', false],
  ['/home/me/p/out-two/x.css', false],
  ['c:/users/me/out/style.css', true],
  ['c:/users/me/out/style.css', false],
  ['/etc/style.css', false],
  ['C:/Windows/x.css', false],
];

const CHAT = 's1';
const screens: Array<[string, unknown[]]> = [
  ['artifact:read', [CHAT, '/tmp/out/report.md']],
  ['artifact:read', [CHAT, 'file:///C:/Users/me/out/index.html']],
  ['artifact:read', [CHAT, 'C:\\Users\\me\\out\\..\\out\\app.js']],
  ['artifact:read', [CHAT, 'relative/a.md']],
  ['artifact:read', [CHAT, 'https://example.com/a.md']],
  ['artifact:read', [CHAT, '/home/me/.ssh/id_ed25519']],
  ['artifact:read', [CHAT, '/home/me/p/.env.html']],
  ['artifact:read', [CHAT, 42]],
  ['artifact:read', [CHAT]],
  ['artifact:read', ['', '/tmp/a.md']],
  ['artifact:read', [{ sessionId: CHAT }, '/tmp/a.md']],
  ['artifact:read', [CHAT, '/tmp/a.md', { maxBytes: 1 }]],
  ['artifact:read', [CHAT, `/${'a'.repeat(4096)}`]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/']],
  ['preview:fetch', [CHAT, 'http://127.0.0.1:5173/app?x=1#top', { method: 'HEAD' }]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', null]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', {}]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', { method: 'POST' }]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', { method: 'get' }]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', { headers: { Cookie: 'a' } }]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', { method: 'GET', body: 'x' }]],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', 'GET']],
  ['preview:fetch', [CHAT, 'http://localhost:5173/', {}, 'extra']],
  ['preview:fetch', [CHAT, 'http://example.com/']],
  ['preview:fetch', [CHAT, 'http://user:pw@localhost:5173/']],
  ['preview:fetch', [CHAT, 'file:///etc/passwd']],
  ['preview:fetch', [CHAT]],
  ['preview:fetch', [7, 'http://localhost:5173/']],
];

const B64 = 'iVBORw0KGgo=';
const views: Array<[string, unknown]> = [
  ['artifact:read', { path: '/tmp/r.md', name: 'r.md', mime: 'text/markdown', size: 7, mtime: 1700000000000, kind: 'text', content: '# Hi\n', truncated: false, abs: '/x' }],
  ['artifact:read', { path: '/tmp/c.png', name: 'c.png', mime: 'image/png', size: 8, mtime: 1, kind: 'binary', base64: B64, truncated: false }],
  ['artifact:read', { path: '/tmp/big.pdf', name: 'big.pdf', mime: 'application/pdf', size: 9e6, mtime: 1, kind: 'binary', truncated: true }],
  ['artifact:read', { path: '/tmp/bad.png', name: 'bad.png', mime: 'image/png', size: 8, mtime: 1, kind: 'binary', base64: 'not base64!', truncated: false }],
  ['artifact:read', { path: '/home/me/.ssh/id_rsa', name: 'id_rsa', kind: 'text', content: 'KEY' }],
  ['artifact:read', { name: 'nopath.md', content: 'x' }],
  ['artifact:read', null],
  ['artifact:read', 'text'],
  ['preview:fetch', { url: 'http://localhost:5173/', status: 200, contentType: 'text/html', headers: { 'content-type': 'text/html', 'set-cookie': 'a=b', etag: '"1"', 'content-length': '5', server: 'vite' }, base64: B64, truncated: false }],
  ['preview:fetch', { url: 'http://localhost:5173/x', status: 302, contentType: '', headers: { location: 'http://evil/', 'cache-control': 7 }, base64: '', truncated: false }],
  ['preview:fetch', { url: 'http://localhost:5173/', status: 200, contentType: 'text/plain', base64: '***', truncated: false }],
  ['preview:fetch', { url: 'http://localhost:5173/', status: 200, headers: 'nope', truncated: true }],
  ['preview:fetch', []],
];

function screenCase(channel: string, args: unknown[]) {
  try {
    return { channel, args, callArgs: screenPhoneCall(channel, args).callArgs ?? null };
  } catch (e) {
    if (!(e instanceof PhoneAccessError)) throw e;
    return { channel, args, error: e.message };
  }
}

it('writes the artifact and preview cases the daemon is held to', () => {
  const golden = {
    links: links.map(([messages, base]) => ({ messages, base, links: chatLinks(messages, base ?? undefined) })),
    paths: paths.map((p) => ({ path: p, local: localPath(p) })),
    urls: urls.map((u) => ({ url: u, parsed: loopbackUrl(u) })),
    access: access.map(([p, ci]) => ({ links: LINKS, path: p, caseInsensitive: ci, access: artifactAccess(p, LINKS, ci) })),
    screens: screens.map(([c, a]) => screenCase(c, a)),
    views: views.map(([channel, result]) => ({ channel, result, view: redactPhoneResult(channel, result) ?? null })),
  };
  // One case per line: reviewable, without the bulk of an indented file.
  const lines = (list: unknown[]) => list.map((c) => JSON.stringify(c)).join(',\n');
  const sections = Object.entries(golden).map(([k, list]) => `${JSON.stringify(k)}:[\n${lines(list)}\n]`);
  const out = `{${sections.join(',')}}\n`;
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, out);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(out));
});
