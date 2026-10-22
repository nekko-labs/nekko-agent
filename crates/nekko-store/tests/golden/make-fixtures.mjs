// Writes the fixture sessions for the summary parity test. Run once when the
// fixtures need to change: node crates/nekko-store/tests/golden/make-fixtures.mjs
// The expected summaries (summaries.json) are a frozen record of the deleted
// TS behaviour; edit them by hand per docs/runbooks/golden-fixtures.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'sessions');
mkdirSync(dir, { recursive: true });
const msg = (id, role, content, extra = {}) => ({ id, role, content, createdAt: 1_790_000_000_000 + id.length, ...extra });
const base = (id, messages, extra = {}) => ({ id, title: `Chat ${id}`, workspaceId: 'w1', messages, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_100_000, ...extra });
const gen = (w, h, seed) => ({ modelId: 'lmstudio/unsloth/FLUX.2-klein-9B-GGUF/flux-2-klein-9b-Q8_0', width: w, height: h, steps: 4, cfgScale: 1, seed, ms: 4100 });

const sessions = [
  base('s_empty', []),
  base('s_plain', [msg('u1', 'user', 'Refactor the parser'), msg('a1', 'assistant', '  Done.\n\nAll   green.  ')]),
  base('s_tools', [
    msg('u1', 'user', 'Open a PR for https://github.com/nekko-labs/nekko-agent/pull/219 follow-up'),
    msg('a1', 'assistant', '', { toolCalls: [
      { id: 'c1', name: 'bash', input: { command: 'gh pr create', retries: 1.0, ratio: 0.25, big: 1e21, tiny: 1e-7, list: [1, 'two', null, true], nested: { b: 2, a: 1 } } },
      { id: 'c2', name: 'noop', input: null },
      { id: 'c3', name: 'noinput' },
    ] }),
    msg('t1', 'tool', '', { toolResult: { toolCallId: 'c1', output: 'Created https://github.com/o/r/pull/7 and (https://github.com/o/r/pull/7).' } }),
    msg('t2', 'tool', '', { toolResult: { toolCallId: 'c2', output: '' } }),
    msg('a2', 'assistant', 'Opened https://github.com/o/r/pull/8.', { reasoning: 'thinking about it '.repeat(50) }),
  ]),
  base('s_space', [
    msg('u1', 'user', ' 　 leading odd spaces'),
    msg('a1', 'assistant', `﻿${'word  \t'.repeat(80)}\u0085end\u0085`),
  ]),
  base('s_long', [
    msg('u1', 'user', 'é'.repeat(2500)),
    msg('a1', 'assistant', 'x'.repeat(5000)),
    msg('u2', 'user', 'short'),
  ]),
  base('s_many', Array.from({ length: 20 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', i % 5 === 4 ? '   ' : `turn ${i} 😀`))),
  base('s_stalled', [msg('u1', 'user', 'go'), msg('a1', 'assistant', 'partial answer', { interrupted: true })]),
  base('s_compacted', [
    msg('u1', 'user', 'old '.repeat(400)),
    msg('a1', 'assistant', 'old answer '.repeat(400)),
    msg('c1', 'assistant', 'Summary of the old work.', { compaction: { summarized: 2 } }),
    msg('u2', 'user', 'carry on'),
    msg('a2', 'assistant', 'Carrying on.'),
  ]),
  base('s_not_stalled', [msg('u1', 'user', 'go'), msg('a1', 'assistant', 'partial', { interrupted: true }), msg('u2', 'user', 'again')]),
  base('s_image', [
    msg('u1', 'user', 'a lighthouse at sunset'),
    msg('a1', 'assistant', '', { images: ['data:image/png;base64,eA=='], generated: gen(1024, 1024, 1417088981) }),
    msg('u2', 'user', 'same, in snow'),
    msg('a2', 'assistant', '', { images: ['data:image/png;base64,eQ==', 'data:image/png;base64,eg=='], generated: gen(768, 1344, 836320352) }),
    msg('a3', 'assistant', 'The image could not be generated: Missing vae'),
  ], { chatType: 'image', imageParams: { modelId: 'm', width: 768, height: 1344, steps: 4, cfgScale: 1, seed: -1 } }),
  base('s_missing', [
    { id: 'x1', role: 'user', content: 'no timestamp' },
    { id: 'x2', role: 'assistant', content: '' },
    { role: 'assistant', content: 'no id', createdAt: null },
    { id: 'x4', role: 'system', content: 'ignored by turns' },
  ]),
  base('s_extra', [msg('u1', 'user', 'hi')], { zeta: 1, alpha: { nested: [1, 2] }, pinned: true, tags: ['a', 'b'], autoModel: false, queue: ['next'] }),
  { id: 's_nomsgs', title: 'broken', updatedAt: 1 },
];
for (const s of sessions) writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(s, null, 2));
console.log(`wrote ${sessions.length} fixtures to ${dir}`);
