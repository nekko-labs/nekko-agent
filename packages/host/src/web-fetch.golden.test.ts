import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { decodeEntities, describeFetched, fetchUrl, htmlToText } from './web-fetch.js';

/**
 * `fetch_url` as the TS host runs it, which the engine daemon's port
 * (crates/nekko-web `fetch`) must reproduce: the HTML-to-text pass, entity
 * decoding, and the page and tool output fetchUrl and describeFetched make of
 * a reply. Writes crates/nekko-web/tests/golden/fetch.json; fails if it is
 * stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-web', 'tests', 'golden', 'fetch.json');

const PAGE = `<!doctype html><html><head><title>Nekko Agent &amp; friends</title><style>p{color:red}</style>
<script>alert(1)</script></head><body><nav><a href="/docs">Docs</a></nav>
<h1>Welcome</h1><p>Local agent, <b>frontier</b> brains.&nbsp;See <a href="https://example.com/x">the guide</a> and <a href="#top">top</a>.</p>
<ul><li>One</li><li>Two &lt;3</li></ul><pre>npm i</pre><img alt="A cat" src="c.png"><!-- hidden --><p>Bye</p></body></html>`;

const HTML: Array<{ html: string; base?: string }> = [
  { html: PAGE, base: 'https://nekkoagent.com/' },
  { html: PAGE },
  { html: '<HEAD><TITLE></TITLE></HEAD><BODY><H2 class=x>Up</H2 ><P>Shout</P></BODY>' },
  { html: '<head><meta charset=utf-8></head><p>no title</p>' },
  { html: '<a href=\'../a b?q=1&amp;r=2#f\'>rel <i>link</i></a> <a href="javascript:void(0)">js</a> <a href="mailto:x@y.z">mail</a> <a href="https://same.test/">https://same.test/</a> <a href="/x"> </a>', base: 'https://h.test/dir/page.html' },
  { html: '<a href="/x">bad base</a>', base: 'not a url' },
  { html: '<table><tr><th>A</th><td>1</td></tr><tr><td>2</td><td>3</td></tr></table>' },
  { html: '<script type="module">x</script ><SCRIPT>y</SCRIPT><svg><path/></svg><iframe src=x></iframe>after<noscript>ns</noscript>' },
  { html: 'line<br>break<br/>and<br />more\n\n\n\n\ngap   \t spaces\r\n  end' },
  { html: '<p>&#128049; &#x1f431; &#X41; &#0; &#99999999999; &AMP; &Hellip; &ldquo;q&rdquo; &nbsp;</p>' },
  { html: '<img alt=""><img alt=" spaced "><img src="x.png">' },
  { html: '<custom-tag>inline</custom-tag><details><summary>S</summary>D</details><hr><address>A</address>' },
  { html: 'emoji 😀 and ſ and K <li>item' },
  { html: '<code>a</code><pre class="x">b</pre><h7>not a heading</h7><h6>six</h6>' },
  { html: '' },
];

const ENTITIES = ['a &amp; b &#169; &#x1F431; &unknown;', '&#;&#x;&amp', '&ampx;&lt;&gt;&quot;&apos;', '&#65&#66;'];

interface Reply { url: string; body: string | number[]; type?: string | null; status?: number; finalUrl?: string; length?: string; maxChars?: number }

const REPLIES: Reply[] = [
  { url: 'https://nekkoagent.com/', body: PAGE, type: 'text/html; charset=utf-8' },
  { url: 'https://x.test/long', body: `<p>${'word '.repeat(10_000)}</p>`, type: 'text/html', maxChars: 1_000 },
  { url: 'https://x.test/a.json', body: '{"a":1}', type: 'application/json' },
  { url: 'https://x.test/a.pdf', body: '%PDF', type: 'application/pdf', length: '1234' },
  { url: 'https://x.test/img', body: 'GIF', type: 'Image/GIF' },
  { url: '  https://x.test/plain  ', body: '  plain text  \n', type: 'text/plain' },
  { url: 'https://x.test/none', body: '<!DOCTYPE html><body><p>sniffed</p></body>', type: null },
  { url: 'https://x.test/none2', body: 'no type, not html', type: null },
  { url: 'https://x.test/latin', body: [0x63, 0x61, 0x66, 0xe9], type: 'text/plain; charset=ISO-8859-1' },
  { url: 'https://x.test/badlabel', body: 'café', type: 'text/plain; charset=nope' },
  { url: 'https://x.test/bom', body: [0xef, 0xbb, 0xbf, 0x68, 0x69], type: 'text/plain' },
  { url: 'https://x.test/redirect', body: '<p>moved</p>', type: 'text/html', finalUrl: 'https://x.test/landed', status: 201 },
  { url: 'https://x.test/xml', body: '<a>x</a>', type: 'application/rss+xml' },
  { url: 'https://x.test/empty', body: '', type: 'text/html' },
  { url: 'https://x.test/emoji', body: '😀'.repeat(800), type: 'text/plain', maxChars: 1_002 },
  { url: 'https://x.test/round', body: 'y'.repeat(3_000), type: 'text/plain', maxChars: 1_500.5 },
  { url: 'https://x.test/huge', body: 'z'.repeat(150_000), type: 'text/plain', maxChars: 1e9 },
  { url: 'HTTP://X.TEST:80/a/../b', body: 'norm', type: 'text/plain' },
  { url: 'ftp://x.test/file', body: '' },
  { url: 'not a url', body: '' },
];

function fakeFetch(r: Reply): typeof fetch {
  return (async () => {
    const headers = new Headers();
    if (r.type != null) headers.set('content-type', r.type);
    if (r.length) headers.set('content-length', r.length);
    const body = typeof r.body === 'string' ? r.body : new Uint8Array(r.body);
    const res = new Response(body, { status: r.status ?? 200, headers });
    // A Response built here has no type when the body is a string; keep only what the case set.
    if (r.type == null) res.headers.delete('content-type');
    if (r.finalUrl) Object.defineProperty(res, 'url', { value: r.finalUrl });
    return res;
  }) as unknown as typeof fetch;
}

it('fetch_url matches the daemon golden set', async () => {
  const replies = [];
  for (const r of REPLIES) {
    try {
      const page = await fetchUrl(r.url, { fetchImpl: fakeFetch(r), maxChars: r.maxChars });
      replies.push({ reply: r, page, output: describeFetched(page) });
    } catch (e) {
      replies.push({ reply: r, error: (e as Error).message });
    }
  }
  const out = {
    html: HTML.map((c) => ({ ...c, text: htmlToText(c.html, c.base) })),
    entities: ENTITIES.map((input) => ({ input, output: decodeEntities(input) })),
    replies,
  };
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
});
