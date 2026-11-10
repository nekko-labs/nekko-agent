import { describe, expect, it } from 'vitest';
import {
  ASK_MAX_QUESTIONS,
  formatAskAnswers,
  isAskComplete,
  parseAskRequest,
  summarizeAsk,
  type AskRequest,
} from './ask.js';

const ok = (input: unknown) => {
  const parsed = parseAskRequest('call_1', input, 1_700_000_000_000);
  if ('error' in parsed) throw new Error(`expected a request, got: ${parsed.error}`);
  return parsed.request;
};

const err = (input: unknown) => {
  const parsed = parseAskRequest('call_1', input, 0);
  if (!('error' in parsed)) throw new Error('expected an error');
  return parsed.error;
};

describe('parseAskRequest', () => {
  it('reads the shape the tool asks for', () => {
    const request = ok({
      questions: [
        {
          header: 'Auth method',
          question: 'How should sign-in work?',
          options: [
            { label: 'Email + password', description: 'The simplest thing' },
            { label: 'OAuth only' },
          ],
        },
      ],
    });
    expect(request.callId).toBe('call_1');
    expect(request.askedAt).toBe(1_700_000_000_000);
    expect(request.questions[0]).toMatchObject({
      id: 'q1',
      header: 'Auth method',
      question: 'How should sign-in work?',
    });
    expect(request.questions[0].options).toEqual([
      { label: 'Email + password', description: 'The simplest thing' },
      { label: 'OAuth only' },
    ]);
  });

  it('accepts options written as plain strings, which models do', () => {
    const request = ok({ questions: [{ header: 'Scope', question: 'How far?', options: ['Just the parser', 'The whole module'] }] });
    expect(request.questions[0].options).toEqual([{ label: 'Just the parser' }, { label: 'The whole module' }]);
  });

  it('falls back to the question text when no header was written', () => {
    const request = ok({ questions: [{ question: 'Which database should this use?', options: ['Postgres', 'SQLite'] }] });
    expect(request.questions[0].header).toBe('Which database should th');
  });

  it('caps the interrogation', () => {
    const request = ok({
      questions: Array.from({ length: 9 }, (_, i) => ({
        header: `H${i}`,
        question: `Q${i}?`,
        options: ['a', 'b'],
      })),
    });
    expect(request.questions).toHaveLength(ASK_MAX_QUESTIONS);
    expect(request.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('refuses a question with nothing to choose between, and says why', () => {
    // A one-option question is a statement, and a zero-option one is a chat
    // message the user cannot reply to. Both come back as something the model
    // can act on rather than as an empty card.
    expect(err({ questions: [{ header: 'X', question: 'Shall I?', options: ['Yes'] }] })).toMatch(/at least 2/);
    expect(err({ questions: [] })).toMatch(/non-empty/);
    expect(err({})).toMatch(/non-empty/);
    expect(err({ questions: [{ header: 'X', options: ['a', 'b'] }] })).toMatch(/no `question` text/);
  });

  it('drops malformed options rather than rendering blank buttons', () => {
    expect(err({ questions: [{ header: 'X', question: 'Which?', options: [{ description: 'no label' }, 'ok'] }] })).toMatch(/at least 2/);
  });
});

describe('formatAskAnswers', () => {
  const request: AskRequest = {
    callId: 'c',
    askedAt: 0,
    questions: [
      { id: 'q1', header: 'Scope', question: 'How far should this go?', options: [{ label: 'Parser' }, { label: 'Module' }] },
      { id: 'q2', header: 'Tests', question: 'Which tests?', options: [{ label: 'Unit' }, { label: 'E2E' }], multiSelect: true },
    ],
  };

  it('echoes every question with its answer', () => {
    const out = formatAskAnswers(request, [
      { questionId: 'q1', labels: ['Parser'] },
      { questionId: 'q2', labels: ['Unit', 'E2E'], note: 'and a smoke test' },
    ]);
    expect(out).toContain('Q: How far should this go?\nA: Parser');
    expect(out).toContain('A: Unit, E2E — and a smoke test');
  });

  it('says which questions were left alone rather than omitting them', () => {
    // A model told only about the answered ones cannot tell a skipped question
    // from one it never asked, and will ask it again.
    const out = formatAskAnswers(request, [{ questionId: 'q1', labels: ['Module'] }]);
    expect(out).toContain('Q: Which tests?\nA: (not answered)');
  });
});

describe('isAskComplete', () => {
  const request: AskRequest = {
    callId: 'c',
    askedAt: 0,
    questions: [
      { id: 'q1', header: 'A', question: 'a?', options: [{ label: '1' }, { label: '2' }] },
      { id: 'q2', header: 'B', question: 'b?', options: [{ label: '1' }, { label: '2' }] },
    ],
  };

  it('counts a typed answer as an answer', () => {
    expect(isAskComplete(request, [
      { questionId: 'q1', labels: [] , note: 'neither, do it this way' },
      { questionId: 'q2', labels: ['1'] },
    ])).toBe(true);
  });

  it('is false while anything is untouched', () => {
    expect(isAskComplete(request, [{ questionId: 'q1', labels: ['1'] }])).toBe(false);
    expect(isAskComplete(request, [{ questionId: 'q1', labels: ['1'] }, { questionId: 'q2', labels: [], note: '  ' }])).toBe(false);
  });
});

describe('summarizeAsk', () => {
  it('leads with the first question and counts the rest', () => {
    const request = ok({
      questions: [
        { header: 'A', question: 'Which parser?', options: ['x', 'y'] },
        { header: 'B', question: 'Which tests?', options: ['x', 'y'] },
      ],
    });
    expect(summarizeAsk(request)).toBe('Which parser? (+1 more)');
  });
});

describe('option actions (#2404)', () => {
  it('keeps the environment actions and drops anything else', () => {
    const request = ok({
      questions: [{
        header: 'Project',
        question: 'Where is hypergate?',
        options: [
          { label: 'Search this computer' },
          { label: 'Use /code/hypergate', action: { kind: 'addFolder', path: ' /code/hypergate ' } },
          { label: 'Choose a folder', action: { kind: 'pickFolder' } },
          { label: 'Add from GitHub', action: { kind: 'connectRepo', path: 'ignored' } },
          { label: 'Odd', action: { kind: 'deleteEverything' } },
        ],
      }],
    });
    const options = request.questions[0]!.options;
    expect(options[0]).toEqual({ label: 'Search this computer' });
    expect(options[1]!.action).toEqual({ kind: 'addFolder', path: '/code/hypergate' });
    expect(options[2]!.action).toEqual({ kind: 'pickFolder' });
    expect(options[3]!.action).toEqual({ kind: 'connectRepo' });
    expect(options[4]).toEqual({ label: 'Odd' });
  });

  it('drops an addFolder action without a path', () => {
    const request = ok({ questions: [{ header: 'h', question: 'q?', options: [{ label: 'a', action: { kind: 'addFolder' } }, 'b'] }] });
    expect(request.questions[0]!.options[0]).toEqual({ label: 'a' });
  });
});
