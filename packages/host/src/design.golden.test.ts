import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** The model's next answer, set per `generate` op. */
const model = vi.hoisted(() => ({ reply: '' }));
vi.mock('./prompt-caching.js', () => ({
  createHostProvider: () => ({
    async *chat() {
      yield { type: 'text', delta: model.reply };
      yield { type: 'done' };
    },
  }),
}));
vi.mock('./oauth.js', () => ({ resolveSubscriptionProvider: async (p: unknown) => p }));

import type { DesignPage } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import * as design from './design.js';

/**
 * What design.ts returns and writes, which the engine daemon's port
 * (crates/nekko-workspace design.rs, plus the model call in nekkod) must
 * reproduce exactly: every board edit, an import, a generation's card and
 * prototype file (the model's answer is scripted), and the pure helpers.
 * Random ids, save times and temp paths are normalized on both sides.
 * Rewrite with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace', 'tests', 'golden');
type Spec = string | { bytes: number[] };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

function norm(v: unknown, root: string, data: string, key?: string): unknown {
  if (typeof v === 'string') {
    let s = v.replace(UUID, '<uuid>');
    if (s.startsWith(root)) s = '<root>' + s.slice(root.length);
    else if (s.startsWith(data)) s = '<data>' + s.slice(data.length);
    if (s.startsWith('<root>') || s.startsWith('<data>')) s = s.replace(/\\/g, '/').replace(/-[0-9a-f]{6}\.html$/, '-<id6>.html');
    return s;
  }
  if (typeof v === 'number' && (key === 'updatedAt' || key === 'createdAt') && v >= 1e12) return 0;
  if (Array.isArray(v)) return v.map((x) => norm(x, root, data));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = norm(x, root, data, k);
    return out;
  }
  return v;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('design golden set', () => {
  it('matches what design.ts returns and writes', async () => {
    const c = JSON.parse(readFileSync(join(golden, 'design-cases.json'), 'utf8'));
    const root = mkdtempSync(join(tmpdir(), 'nekko-design-root-'));
    const data = mkdtempSync(join(tmpdir(), 'nekko-design-data-'));
    dirs.push(root, data);
    for (const [rel, spec] of Object.entries(c.files as Record<string, Spec>)) {
      writeFileSync(join(root, rel), typeof spec === 'string' ? spec : Buffer.from(spec.bytes));
    }
    mkdirSync(join(root, 'w2'), { recursive: true });
    setDataDir(data);
    saveSettings({
      workspaces: [{ id: 'w1', name: 'w1', path: root, addedAt: 0 }, { id: 'w2', name: 'w2', path: join(root, 'w2'), addedAt: 0 }],
      providers: [{ id: 'p', kind: 'llamacpp', label: 'Local', baseUrl: 'http://127.0.0.1:9/v1', enabled: true }],
      defaultProviderId: 'p',
      defaultModelId: 'm',
    });
    const page = (ws: string, i: number): DesignPage | undefined => design.getDesignBoard(ws).pages[i];
    const run = async ([op, ...a]: [string, ...any[]]): Promise<unknown> => {
      switch (op) {
        case 'get': return design.getDesignBoard(a[0]);
        case 'add': return design.addDesignPage(a[0], a[1], a[2]);
        case 'addImport': return design.addDesignPage(a[0], a[1], join(root, a[2]));
        case 'update': return design.updateDesignPage(a[0], page(a[0], a[1])?.id as string, a[2]);
        case 'remove': return design.removeDesignPage(a[0], page(a[0], a[1])?.id as string);
        case 'note': return design.addDesignNote(a[0], page(a[0], a[1])?.id as string, a[2]);
        case 'resolve': return design.resolveDesignNote(a[0], page(a[0], a[1])?.id as string, page(a[0], a[1])?.notes[a[2]]?.id as string);
        case 'file': {
          const f = page('w1', a[0])?.file;
          return f ? readFileSync(f, 'utf8') : null;
        }
        case 'generate': {
          const { pageIndex, ...input } = a[1];
          if (pageIndex !== undefined) input.pageId = page(a[0], pageIndex)?.id;
          model.reply = a[2];
          return design.generateDesign(a[0], input);
        }
        default: throw new Error(`unknown op ${op}`);
      }
    };
    const ops: unknown[] = [];
    for (const o of c.ops) {
      try {
        ops.push({ op: o[0], result: norm(await run(o), root, data) });
      } catch (e) {
        ops.push({ op: o[0], error: (e as Error).message });
      }
    }
    const actual = {
      ops,
      asks: c.asks.map(([existing, input, prompt]: [never, never, string]) => design.designAsk(existing ?? undefined, input, prompt)),
      cleans: c.cleans.map((raw: string) => { try { return design.cleanDesignOutput(raw); } catch (e) { return { error: (e as Error).message }; } }),
      labels: c.labels.map(([input, existing, prompt]: [never, never, string]) => design.designLabel(input, existing ?? undefined, prompt)),
      slugs: c.slugs.map((l: string) => design.designSlug(l)),
      system: design.DESIGN_SYSTEM,
    };
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    const path = join(golden, 'design.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
