import { describe, expect, it } from 'vitest';
import { ASK_CANCELLED, ASK_UNATTENDED, formatAskAnswers, parseAskRequest } from '../../../../../../packages/shared/src/ask.js';
import type { ChatMessage } from '@nekko-agent/shared';
import { collectSessionPrUrls, extractPrUrls } from '../../../../../../packages/shared/src/pr.js';
import { activityRows, estimateRowHeight, fmtDateTime, fmtTime, toStreamBlocks, toTranscriptRows, transcriptBeforeLiveTurn, transcriptRowStamp, type Activity } from './transcript.js';
import { fmtElapsed } from './ActivityGroup.js';

const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, content, createdAt: 0, ...extra,
});
const rows = (messages: ChatMessage[]) => toTranscriptRows(messages, extractPrUrls, collectSessionPrUrls);

describe('toTranscriptRows', () => {
  it('lays a turn out as message, steps, answer', () => {
    const r = rows([
      msg('u', 'user', 'fix it'),
      msg('a1', 'assistant', '', { toolCalls: [{ id: 'c', name: 'read_file', input: {} }] }),
      msg('t', 'tool', 'contents', { toolResult: { toolCallId: 'c', output: 'contents' } }),
      msg('a2', 'assistant', 'Fixed.'),
    ]);
    expect(r.map((x) => x.kind)).toEqual(['msg', 'activity', 'msg']);
    expect(new Set(r.map((x) => x.key)).size).toBe(r.length);
  });

  it('stops at the live turn\'s prompt while the run draws that turn', () => {
    // The daemon checkpoints the transcript after every tool result. Mid-turn
    // the persisted copy already holds the turn's narration and tool calls,
    // which the live run is drawing below the transcript; the transcript must
    // not draw them too.
    const turn = [
      msg('u0', 'user', 'earlier'),
      msg('a0', 'assistant', 'Earlier answer.'),
      msg('u', 'user', 'finish the PRs'),
      msg('a1', 'assistant', "I'll start by reading the guidance.", { toolCalls: [{ id: 'c1', name: 'read_file', input: {} }] }),
      msg('t1', 'tool', '', { toolResult: { toolCallId: 'c1', output: 'x' } }),
    ];
    expect(transcriptBeforeLiveTurn(turn).map((m) => m.id)).toEqual(['u0', 'a0', 'u']);
    // Nothing to cut when the prompt is already the tail (same array back), or there is no prompt.
    const tail = turn.slice(0, 3);
    expect(transcriptBeforeLiveTurn(tail)).toBe(tail);
    expect(transcriptBeforeLiveTurn([])).toEqual([]);
    const noPrompt = [msg('a9', 'assistant', 'only')];
    expect(transcriptBeforeLiveTurn(noPrompt)).toBe(noPrompt);
    const r = rows(transcriptBeforeLiveTurn(turn));
    expect(r.map((x) => x.kind)).toEqual(['msg', 'msg', 'msg']);
    expect(r.filter((x) => x.kind === 'msg' && x.message.role === 'assistant')).toHaveLength(1);
  });

  it('anchors discoveries including tool-only PRs instead of moving them after new messages', () => {
    const pr1 = 'https://github.com/o/r/pull/1';
    const pr2 = 'https://github.com/o/r/pull/2';
    const base = [msg('u', 'user', 'make PRs'), msg('a1', 'assistant', 'Opened ' + pr1, { toolCalls: [{ id: 'x', name: 'bash', input: { command: 'gh pr create' } }] }),
      msg('t', 'tool', '', { toolResult: { toolCallId: 'x', output: pr1 } }),
      msg('a-create2', 'assistant', '', { toolCalls: [{ id: 'y', name: 'bash', input: { command: 'gh pr create' } }] }),
      msg('t2', 'tool', '', { toolResult: { toolCallId: 'y', output: pr2 } })];
    const before = rows(base);
    const after = rows([...base, msg('u2', 'user', 'run the build'), msg('a2', 'assistant', 'Building.')]);
    expect(before.filter((r) => r.kind === 'prs').map((r) => r.urls)).toEqual([[pr1], [pr2]]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ kind: 'msg', message: { id: 'a2' } });
  });

  it('keeps created and merged milestones separate, before later replies', () => {
    const url = 'https://github.com/o/r/pull/1';
    const messages = [msg('a', 'assistant', '', { createdAt: 90, toolCalls: [{ id: 'create', name: 'bash', input: { command: 'gh pr create' } }] }), msg('t', 'tool', url, { createdAt: 100, toolResult: { toolCallId: 'create', output: url } }), msg('merged', 'assistant', 'Merged.', { createdAt: 200 }), msg('u', 'user', 'Next task', { createdAt: 400 })];
    const prs = [{ url, state: 'merged', mergedAt: new Date(250).toISOString() }] as any;
    const result = toTranscriptRows(messages, extractPrUrls, collectSessionPrUrls, prs);
    expect(result.map((r) => r.kind === 'prs' ? r.event : r.kind === 'msg' ? r.message.id : r.kind)).toEqual(['activity', 'created', 'merged', 'merged', 'u']);
    expect(new Set(result.map((r) => r.key)).size).toBe(result.length);
  });

  it('does not append phantom PR cards from reading test fixtures', () => {
    const r = rows([
      msg('a', 'assistant', '', { toolCalls: [{ id: 'read', name: 'read_file', input: {} }] }),
      msg('t', 'tool', '', { toolResult: { toolCallId: 'read', output: 'https://github.com/o/r/pull/1' } }),
      msg('done', 'assistant', 'Read the tests.'),
    ]);
    expect(r.map((x) => x.kind)).toEqual(['activity', 'msg']);
  });

  it('keeps keys stable as messages are appended', () => {
    const base = [msg('u', 'user', 'a'), msg('a', 'assistant', 'b')];
    const before = rows(base).map((x) => x.key);
    const after = rows([...base, msg('u2', 'user', 'c')]).map((x) => x.key);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('gives duplicate ids their own keys', () => {
    const r = rows([msg('tmp', 'user', 'a'), msg('tmp', 'user', 'b')]);
    expect(r[0].key).not.toBe(r[1].key);
  });

  it('skips an assistant message that would render nothing', () => {
    expect(rows([msg('u', 'user', 'hi'), msg('a', 'assistant', '')])).toHaveLength(1);
  });

  it('keeps an image-chat reply that is only a picture, and sizes it by its aspect', () => {
    const generated = { modelId: 'flux', width: 1024, height: 512, steps: 4, cfgScale: 1, seed: 7, ms: 4400 };
    const r = rows([msg('u', 'user', 'a cat'), msg('a', 'assistant', '', { images: ['data:image/png;base64,eA=='], generated })]);
    expect(r).toHaveLength(2);
    const tall = rows([msg('b', 'assistant', '', { images: ['x'], generated: { ...generated, height: 2048 } })])[0];
    expect(estimateRowHeight(tall, 800)).toBeGreaterThan(estimateRowHeight(r[1], 800));
  });
});

describe('persisted ask_user replies', () => {
  const call = { id: 'ask', name: 'ask_user', input: { questions: [
    { header: 'Scope', question: 'Which scope?', options: ['Module, literal', 'Everything'] },
    { header: 'Tests', question: 'Which tests?', options: ['Focused', 'All'] },
  ] } };
  const parsed = parseAskRequest(call.id, call.input, 1);
  if ('error' in parsed) throw new Error(parsed.error);
  const output = formatAskAnswers(parsed.request, [{ questionId: 'q1', labels: ['Module, literal'], note: 'Keep **this**\nexact note' }]);
  const asking = msg('asking', 'assistant', '', { toolCalls: [call], createdAt: 1 });
  const reply = (text = output, isError = false) => msg('result', 'tool', '', {
    createdAt: 2, toolResult: { toolCallId: call.id, output: text, isError },
  });
  const visible = (messages: ChatMessage[]) => rows(messages).filter((r) => r.kind === 'msg').map((r) => r.message);

  it('shows literal selections, notes and unanswered questions without the model wrapper', () => {
    const messages = [asking, reply(), msg('done', 'assistant', 'Done.')];
    const snapshot = JSON.stringify(messages);
    expect(visible(messages)[0]).toEqual({ id: 'result_ask_reply', role: 'user', createdAt: 2,
      content: 'Q: Which scope?\nA: Module, literal \u2014 Keep **this**\nexact note\n\nQ: Which tests?\nA: (not answered)' });
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(visible(messages)[0].content).not.toContain('Work to these answers');
  });

  it('does not invent an answer while pending or when a result is failed, malformed or orphaned', () => {
    expect(visible([asking])).toEqual([]);
    expect(visible([asking, reply(output, true)])).toEqual([]);
    expect(visible([asking, reply('Question 1 has no question text.')])).toEqual([]);
    expect(visible([asking, reply('The user answered:\n\nincomplete')])).toEqual([]);
    expect(visible([reply()])).toEqual([]);
    expect(visible([reply(), asking])).toEqual([]);
    expect(visible([asking, reply(), reply()])).toHaveLength(1);
    expect(visible([msg('bad', 'assistant', '', { toolCalls: [{ ...call, input: {} }] }), reply()])).toEqual([]);
    expect(visible([msg('other', 'assistant', '', { toolCalls: [{ ...call, name: 'bash' }] }), reply()])).toEqual([]);
  });

  it('classifies a long history by identity without scanning it for every row', () => {
    const real = msg('result_ask_reply', 'user', 'A persisted message with a colliding projection id');
    const messages = [asking, reply(), ...Array.from({ length: 1000 }, (_, i) => msg(`u${i}`, 'user', `Turn ${i}`)), real];
    messages.includes = () => { throw new Error('per-row history scan'); };
    const result = rows(messages).filter((r) => r.kind === 'msg');
    expect(result[0].displayOnly).toBe(true);
    expect(result.slice(1).every((r) => !r.displayOnly)).toBe(true);
    expect(result.at(-1)?.message).toBe(real);
  });

  it('shows skipped and unattended states without exposing instructions', () => {
    for (const [text, state] of [[ASK_CANCELLED, '(skipped / not answered)'], [ASK_UNATTENDED, '(not answered: unattended time limit)']]) {
      expect(visible([asking, reply(text)])[0].content).toBe(`Q: Which scope?\nA: ${state}\n\nQ: Which tests?\nA: ${state}`);
    }
  });

  it('splits activity at the result chronology, including streaming calls and later user turns', () => {
    const before = [msg('u', 'user', 'Start'), asking,
      msg('work', 'assistant', '', { toolCalls: [{ id: 'read', name: 'read_file', input: {} }] }),
      msg('read-result', 'tool', 'hidden', { toolResult: { toolCallId: 'read', output: 'hidden' } }), reply(),
      msg('stream', 'assistant', '', { toolCalls: [{ id: 'next', name: 'bash', input: {} }] })];
    const result = rows(before);
    expect(result.map((r) => r.kind === 'msg' ? r.message.id : r.kind)).toEqual(['u', 'activity', 'result_ask_reply', 'activity']);
    const later = rows([...before, msg('done', 'assistant', 'Done.'), msg('u2', 'user', 'Next')]);
    expect(later.slice(0, result.length)).toEqual(result);
    expect(later.filter((r) => r.kind === 'msg' && r.message.id === 'result_ask_reply')).toHaveLength(1);
  });

  it('retains call context across PR anchors and keeps real user messages intact, even duplicate ids', () => {
    const url = 'https://github.com/o/r/pull/8';
    const messages = [asking, msg('pr', 'assistant', '', { toolCalls: [{ id: 'pr-call', name: 'bash', input: {} }] }),
      msg('pr-result', 'tool', url, { toolResult: { toolCallId: 'pr-call', output: url } }), reply(),
      msg('same', 'user', 'Module, literal'), msg('same', 'user', 'Module, literal')];
    const result = toTranscriptRows(messages, extractPrUrls, () => [url]);
    expect(result.map((r) => r.kind)).toEqual(['activity', 'prs', 'msg', 'msg', 'msg']);
    expect(visible(messages).map((m) => m.content)).toEqual([
      output.slice('The user answered:\n\n'.length, -'\n\nWork to these answers. Do not ask again about anything settled here.'.length),
      'Module, literal', 'Module, literal',
    ]);
    expect(new Set(result.map((r) => r.key)).size).toBe(result.length);
  });
});

describe('estimateRowHeight', () => {
  it('grows with the text and shrinks with the width', () => {
    const [short] = rows([msg('a', 'assistant', 'one line')]);
    const [long] = rows([msg('b', 'assistant', 'word '.repeat(400))]);
    expect(estimateRowHeight(long, 600)).toBeGreaterThan(estimateRowHeight(short, 600));
    expect(estimateRowHeight(long, 400)).toBeGreaterThan(estimateRowHeight(long, 900));
  });
});

describe('message timestamps', () => {
  it('format exactly as the Date locale methods they replace', () => {
    for (const ts of [Date.UTC(2026, 0, 1, 9, 5), Date.UTC(2026, 8, 30, 23, 59, 58), 1]) {
      expect(fmtTime(ts)).toBe(new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      expect(fmtDateTime(ts)).toBe(new Date(ts).toLocaleString());
    }
    expect(fmtTime(0)).toBe('');
  });
});

describe('compaction rows', () => {
  const none = () => [];
  it('puts a divider row where the chat was compacted, after the turns it replaced', () => {
    const rows = toTranscriptRows([
      msg('u1', 'user', 'old'),
      msg('a1', 'assistant', 'old answer'),
      msg('c1', 'assistant', 'S1', { compaction: { summarized: 2 } }),
      msg('u2', 'user', 'new'),
      msg('c2', 'assistant', 'S2', { compaction: { summarized: 4 } }),
      msg('u3', 'user', 'newest'),
    ], none, none);
    expect(rows.map((r) => r.kind)).toEqual(['msg', 'msg', 'compaction', 'msg', 'compaction', 'msg']);
    const summaries = rows.filter((r) => r.kind === 'compaction');
    expect(summaries.map((r) => r.kind === 'compaction' && r.latest)).toEqual([false, true]);
    expect(estimateRowHeight(summaries[1], 600)).toBeGreaterThan(estimateRowHeight(summaries[0], 600));
  });
});

describe('step timing', () => {
  const at = new Date(2026, 9, 24, 15, 42).getTime();
  const messages = [
    { id: 'u', role: 'user', content: 'go', createdAt: at - 1000 },
    { id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', input: {} }], createdAt: at },
    { id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: 'ok' }, createdAt: at + 1500 },
  ] as ChatMessage[];

  it('gives a persisted tool call its start and end', () => {
    const run = toStreamBlocks(messages).find((b) => b.type === 'activity');
    expect(run?.type === 'activity' && run.items[0]).toMatchObject({ startedAt: at, endedAt: at + 1500 });
  });

  it('stamps message and step rows with their time', () => {
    expect(rows(messages).map(transcriptRowStamp)).toEqual([fmtTime(at - 1000), fmtTime(at)]);
  });

  it('formats elapsed times compactly', () => {
    expect([400, 12_300, 125_000, 3_720_000].map(fmtElapsed)).toEqual(['0.4s', '12s', '2m 5s', '1h 2m']);
  });
});

describe('purpose groups (spec/chat/tool-calls-grouped-by-purpose.md)', () => {
  const tool = (id: string, name: string, input: Record<string, unknown>, extra: { failed?: boolean } = {}): Activity => ({ kind: 'tool', call: { id, name, input }, ...extra });
  const shape = (items: Activity[], pending?: string) => activityRows(items, pending).map((r) => (r.kind === 'group' ? `${r.purpose}:${r.steps.map((s) => s.index).join(',')}` : String(r.step.index)));

  it('folds only adjacent calls of one purpose, keeping each step\'s number', () => {
    expect(shape([
      tool('a', 'read_file', { path: 'AGENTS.md' }),
      tool('b', 'read_file', { path: 'CLAUDE.md' }),
      { kind: 'reasoning', text: 'So the parser is the place.', duration: 1 },
      tool('c', 'read_file', { path: 'src/parser.ts' }),
      tool('d', 'grep', { pattern: 'parse' }),
      tool('e', 'edit_file', { path: 'src/parser.ts' }),
      tool('f', 'bash', { command: 'npm test' }),
      tool('g', 'bash', { command: 'npx vitest run' }),
    ])).toEqual(['guidance:1,2', '3', 'explore:4,5', '6', 'check:7,8']);
  });

  it('folds a thought between same-purpose calls in with them', () => {
    expect(shape([
      tool('a', 'read_file', { path: 'a.ts' }),
      { kind: 'reasoning', text: 'Next file.', duration: 1 },
      tool('b', 'read_file', { path: 'b.ts' }),
    ])).toEqual(['explore:1,2,3']);
  });

  it('keeps the approval-pending call, questions and delegations out of groups', () => {
    expect(shape([
      tool('a', 'bash', { command: 'npm install' }),
      tool('b', 'bash', { command: 'node x.mjs' }),
      tool('c', 'bash', { command: 'rm -rf build' }),
    ], 'c')).toEqual(['run:1,2', '3']);
    expect(shape([
      tool('a', 'read_file', { path: 'a.ts' }),
      tool('q', 'ask_user', { questions: [] }),
      tool('b', 'read_file', { path: 'b.ts' }),
      tool('s', 'spawn_agent', { task: 'x' }),
      tool('t', 'spawn_agent', { task: 'y' }),
    ])).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps a failed call in its group and marks it failed from the result', () => {
    const blocks = toStreamBlocks([
      msg('u', 'user', 'test it'),
      msg('a', 'assistant', '', { toolCalls: [{ id: 'x', name: 'bash', input: { command: 'npm test' } }, { id: 'y', name: 'bash', input: { command: 'npm run lint' } }] }),
      msg('t1', 'tool', 'ok', { toolResult: { toolCallId: 'x', output: 'ok' } }),
      msg('t2', 'tool', 'bad', { toolResult: { toolCallId: 'y', output: 'bad', isError: true } }),
    ]);
    const act = blocks.find((b) => b.type === 'activity');
    const items = act && act.type === 'activity' ? act.items : [];
    expect(items.map((it) => it.kind === 'tool' && !!it.failed)).toEqual([false, true]);
    const [group] = activityRows(items);
    expect(group.kind === 'group' && group.calls.filter((c) => c.failed).length).toBe(1);
  });

  it('streams new calls into the open group', () => {
    const items: Activity[] = [tool('a', 'read_file', { path: 'AGENTS.md' })];
    expect(shape(items)).toEqual(['1']);
    items.push(tool('b', 'read_file', { path: 'CLAUDE.md' }));
    expect(shape(items)).toEqual(['guidance:1,2']);
    items.push(tool('c', 'read_file', { path: 'docs/runbooks/landing-a-pr.md' }));
    expect(shape(items)).toEqual(['guidance:1,2,3']);
  });
});

describe('inline thought projection', () => {
  it('does not repeat the thought in a final answer that also called a tool', () => {
    const blocks = toStreamBlocks([msg('a', 'assistant', 'Finished', {
      reasoning: 'Check first', toolCalls: [{ id: 'c', name: 'read_file', input: {} }],
    })]);
    expect(blocks[0].type === 'activity' && blocks[0].items[0]).toMatchObject({ kind: 'reasoning', text: 'Check first' });
    expect(blocks[1].type === 'msg' && blocks[1].message.reasoning).toBeUndefined();
  });
});
