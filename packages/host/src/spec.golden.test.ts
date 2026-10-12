import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** The scripted model: its next answer, and the request it was sent. */
const model = vi.hoisted(() => ({ reply: '', last: null as null | { system?: string; prompt?: string; model?: string; temperature?: number } }));
vi.mock('./prompt-caching.js', () => ({
  createHostProvider: () => ({
    async *chat(req: { system?: string; model: string; temperature?: number; messages: Array<{ content: string }> }) {
      model.last = { system: req.system, prompt: req.messages[0]?.content, model: req.model, temperature: req.temperature };
      yield { type: 'text', delta: model.reply };
      yield { type: 'done' };
    },
  }),
}));
vi.mock('./oauth.js', () => ({ resolveSubscriptionProvider: async (p: unknown) => p }));

import { SPEC_METHODOLOGIES, toggleTaskLine } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import { getSession } from './sessions.js';
import * as spec from './spec.js';

/**
 * spec.ts, which the engine daemon's port (crates/nekko-workspace spec.rs,
 * the model call in nekkod) must reproduce exactly: paths, doc status, task
 * toggles, the methodology a chat uses, and builds over a scripted model
 * (the request it was sent included). Writes `src/spec-data.json`, the
 * methodologies the Rust side embeds, and `tests/golden/spec.json`.
 * Rewrite with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace');
const golden = join(crate, 'tests', 'golden');

function norm(v: unknown, root: string): unknown {
  if (typeof v === 'string') return v.includes(root) ? v.split(root).join('<root>').replace(/\\/g, '/') : v;
  if (Array.isArray(v)) return v.map((x) => norm(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, root)]));
  return v;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('spec golden set', () => {
  it('writes the methodologies the Rust side embeds', () => {
    const text = `${JSON.stringify({ methodologies: SPEC_METHODOLOGIES }, null, 2)}\n`;
    const path = join(crate, 'src', 'spec-data.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('matches what spec.ts returns and writes', async () => {
    const c = JSON.parse(readFileSync(join(golden, 'spec-cases.json'), 'utf8'));
    const root = mkdtempSync(join(tmpdir(), 'nekko-spec-root-'));
    const data = mkdtempSync(join(tmpdir(), 'nekko-spec-data-'));
    dirs.push(root, data);
    for (const [rel, text] of Object.entries(c.files as Record<string, string>)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    for (const d of c.dirs as string[]) mkdirSync(join(root, d), { recursive: true });
    mkdirSync(join(data, 'sessions'), { recursive: true });
    for (const [id, s] of Object.entries(c.sessions)) writeFileSync(join(data, 'sessions', `${id}.json`), JSON.stringify(s, null, 2));
    setDataDir(data);
    saveSettings({
      workspaces: [{ id: 'w1', name: 'w1', path: join(root, 'w1'), addedAt: 0 }, { id: 'w2', name: 'w2', path: join(root, 'w2'), addedAt: 0 }],
      providers: [{ id: 'p', kind: 'llamacpp', label: 'Local', baseUrl: 'http://127.0.0.1:9/v1', enabled: true }],
    });
    const run = async ([op, ...a]: [string, ...any[]]): Promise<unknown> => {
      switch (op) {
        case 'path': return spec.specPathForSession(a[0]);
        case 'docs': return spec.readSpecDocs(a[0], a[1]);
        case 'toggle': return spec.toggleSpecTask(a[0], a[1], a[2]);
        case 'method': return spec.setSpecMethodology(a[0], a[1]) ?? null;
        case 'field': return (getSession(a[0]) as unknown as Record<string, unknown>)?.[a[1]] ?? null;
        case 'file': return readFileSync(join(root, a[0]), 'utf8');
        case 'build': {
          model.reply = a[3];
          model.last = null;
          const result = await spec.buildSpecDoc(a[0], a[1] ?? undefined, a[2] ?? undefined);
          return { result, request: model.last };
        }
        default: throw new Error(`unknown op ${op}`);
      }
    };
    const ops: unknown[] = [];
    for (const o of c.ops) {
      try {
        ops.push({ op: o[0], result: norm(await run(o), root) });
      } catch (e) {
        ops.push({ op: o[0], error: (e as Error).message });
      }
    }
    const actual = { ops, toggles: c.toggles.map(([md, i]: [string, number]) => toggleTaskLine(md, i)) };
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    const path = join(golden, 'spec.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
