import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { withDataDir } from './paths.js';
import { previewContext } from './chat.js';

/**
 * What the engine daemon's Context panel (crates/nekkod/src/context.rs) must
 * reproduce exactly: `previewContext` for every case over a tree built from
 * `golden/context-preview/fixtures.json`, with the tree's root written as
 * `<root>`, path separators as `/`, and the platform pinned to `linux` (so the
 * set is the same on every OS). Fails when `expected.json` is stale; rewrite
 * it with `UPDATE_GOLDEN=1`.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekkod', 'tests', 'golden', 'context-preview');

interface Fixtures {
  files: Record<string, string>;
  settings: unknown;
  sessions: Array<{ id: string }>;
  cases: Array<{ session: string | null; attached: string[] }>;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function normalize(v: unknown, root: string): unknown {
  if (typeof v === 'string') return v.split(root).join('<root>').replace(/\\/g, '/');
  if (Array.isArray(v)) return v.map((x) => normalize(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [normalize(k, root) as string, normalize(x, root)]));
  return v;
}

describe('context preview golden set', () => {
  it('matches what previewContext returns for every case', async () => {
    const fx = JSON.parse(readFileSync(join(golden, 'fixtures.json'), 'utf8')) as Fixtures;
    const outer = mkdtempSync(join(tmpdir(), 'nekko-ctx-preview-'));
    roots.push(outer);
    // The prompt counts absolute folder paths. Keep their UTF-16 length fixed
    // across platforms so a temp-directory spelling cannot change the golden.
    const root = join(outer, 'x'.repeat(127 - outer.length));
    mkdirSync(root);
    expect(root.length).toBe(128);
    const fill = (v: unknown): unknown => JSON.parse(JSON.stringify(v).split('<root>').join(root.replace(/\\/g, '\\\\')));
    for (const [rel, text] of Object.entries(fx.files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    const data = join(root, 'data');
    mkdirSync(join(data, 'sessions'), { recursive: true });
    writeFileSync(join(data, 'settings.json'), JSON.stringify(fill(fx.settings)));
    for (const s of fx.sessions) writeFileSync(join(data, 'sessions', `${s.id}.json`), JSON.stringify(fill(s), null, 2));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const actual: unknown[] = [];
    try {
      for (const c of fx.cases) {
        const bundle = await withDataDir(data, () => previewContext(c.session ?? 's_missing', fill(c.attached) as string[]));
        actual.push(normalize(JSON.parse(JSON.stringify(bundle)), root));
      }
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    const path = join(golden, 'expected.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });
});
