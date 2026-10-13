import { describe, expect, it } from 'vitest';
import { ASK_CANCELLED, ASK_UNATTENDED, formatAskAnswers, parseAskRequest } from '../../../../../../packages/shared/src/ask.js';
import type { ChatMessage } from '@nekko-agent/shared';
import { collectSessionPrUrls, extractPrUrls } from '../../../../../../packages/shared/src/pr.js';
import { estimateRowHeight, fmtDateTime, fmtTime, toTranscriptRows } from './transcript.js';

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
