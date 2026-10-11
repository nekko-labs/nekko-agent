import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { assembleContext, buildSystemPrompt, renderContextBlock } from '@nekko-agent/core';
import { collectAttached, collectGuidelines } from './chat.js';
import { listMemory } from './memory.js';
import { setDataDir } from './paths.js';

/**
 * What the TS host builds for a turn's context, which the engine daemon's
 * port (crates/nekko-context) must reproduce exactly. Both sides materialize
 * `golden/fixtures.json` into a temp tree and run the same steps; the temp
 * root and path separators are the only things normalized. Rewrite with
 * UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-context', 'tests', 'golden');

interface Fixtures {
  files: Record<string, { text?: string; repeat?: number; base64?: string; dir?: boolean }>;
  workspaces: Array<{ id: string; name: string; rel: string }>;
  attached: string[];
  connectorSnippets: Array<{ label: string; origin: string; body: string }>;
  indexSnippets: Array<{ relPath: string; path: string; body: string }>;
  history: never[];
  excluded: string[];
  pinned: string[];
  contextWindow: number;
  prompts: Array<{ workspaces: [] | 'fixture'; contextBlock: string; platform: string; canAsk?: boolean; canPlan?: boolean; orchestrationHint?: string; systemInstructions?: string; aboutUser?: string; turnWrapper?: string; checkoutNotice?: string }>;
}

describe('context golden set', () => {
  it('matches what the TS host builds for a turn', () => {
    const fx = JSON.parse(readFileSync(join(golden, 'fixtures.json'), 'utf8')) as Fixtures;
    const root = mkdtempSync(join(tmpdir(), 'nekko-context-'));
    try {
      for (const [rel, f] of Object.entries(fx.files)) {
        const p = join(root, rel);
        if (f.dir) { mkdirSync(p, { recursive: true }); continue; }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.base64 ? Buffer.from(f.base64, 'base64') : (f.text ?? '').repeat(f.repeat ?? 1));
      }
      // Raw, unnormalized workspace paths, the way settings hold them. The prompt
      // lists fixed ones instead: its token count must not depend on the temp dir.
      const workspaces = fx.workspaces.map((w) => ({ ...w, path: `${root}/${w.rel}` }));
      const wsPath = Object.fromEntries(workspaces.map((w) => [w.id.replace('w', 'ws'), w.path]));
      const expand = (id: string) => id.replace(/^guideline:<(\w+)>\/(.+)$/, (_, ws: string, name: string) => `guideline:${join(wsPath[ws], name)}`);

      setDataDir(join(root, 'data'));
      const guidelines = collectGuidelines(workspaces);
      const attached = collectAttached(fx.attached.map((a) => join(root, a)));
      const memory = [...listMemory('global'), ...listMemory('workspace', 'w1')];
      const systemText = buildSystemPrompt({ workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, path: `/fixture/${w.rel}` })), contextBlock: '', platform: 'win32' });
      const bundle = assembleContext({
        attached,
        guidelines,
        memory,
        connectorSnippets: fx.connectorSnippets,
        indexSnippets: fx.indexSnippets,
        history: fx.history,
        systemText,
        contextWindow: fx.contextWindow,
        excluded: new Set(fx.excluded.map(expand)),
        pinned: new Set(fx.pinned),
      });
      const block = renderContextBlock(bundle, bundle.contents ?? new Map());
      const { contents: _contents, ...inspector } = bundle;
      const prompts = fx.prompts.map((p) => buildSystemPrompt({
        workspaces: p.workspaces === 'fixture' ? workspaces.map((w) => ({ id: w.id, name: w.name, path: `/fixture/${w.rel}` })) : [],
        contextBlock: p.contextBlock === 'rendered' ? block : p.contextBlock,
        platform: p.platform,
        canAsk: p.canAsk,
        canPlan: p.canPlan,
        orchestrationHint: p.orchestrationHint,
        systemInstructions: p.systemInstructions,
        aboutUser: p.aboutUser,
        turnWrapper: p.turnWrapper,
        checkoutNotice: p.checkoutNotice,
      }));
      const out = { guidelines, attached, memory, bundle: inspector, block, prompts };
      // The one machine-specific part: where the tree was made, and the separator.
      const text = JSON.stringify(out, null, 2).split(JSON.stringify(root).slice(1, -1)).join('<root>').replace(/\\\\/g, '/');
      const actual = JSON.parse(text);
      const path = join(golden, 'expected.json');
      if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
