import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AskQuestion, AskRequest } from '@nekko-agent/shared';
import { isAskComplete } from '@nekko-agent/shared';
import { QuestionCard, toAnswers, togglePick } from './QuestionCard.js';

const request: AskRequest = {
  callId: 'call_1',
  askedAt: 0,
  questions: [
    {
      id: 'q1',
      header: 'Auth method',
      question: 'How should people sign in?',
      options: [
        { label: 'Magic link', description: 'Email a one-time link.' },
        { label: 'Password', description: 'Classic email and password.' },
      ],
    },
    {
      id: 'q2',
      header: 'Tests',
      question: 'Which tests should it come with?',
      options: [{ label: 'Unit' }, { label: 'End to end' }],
      multiSelect: true,
    },
  ],
};

const html = (r: AskRequest = request) =>
  renderToStaticMarkup(<QuestionCard request={r} onAnswer={() => {}} onSkip={() => {}} />);

describe('QuestionCard', () => {
  it('defaults to orange attention styling with brighter panel and option surfaces', () => {
    const out = html();
    expect(out).toContain('data-question-tone="attention"');
    expect(out).toContain('--accent:var(--warning)');
    expect(out).toContain('--on-accent:#201609');
    expect(out).toContain('var(--warning) 8%, var(--surface-2)');
    expect(out).toContain('white 4%, var(--surface-2)');
    expect(out).not.toContain('background:var(--surface)');
  });

  it('preserves an explicit accent opt-in without a self-referencing accent variable', () => {
    const out = renderToStaticMarkup(<QuestionCard tone="accent" compact request={request} onAnswer={() => {}} onSkip={() => {}} />);
    expect(out).toContain('data-question-tone="accent"');
    expect(out).not.toContain('--accent:');
  });

  it('asks one question at a time rather than laying the whole form out', () => {
    const out = html();
    expect(out).toContain('>How should people sign in?<');
    expect(out).toContain('Magic link');
    // The second question is not laid out at all: its options are nowhere on
    // the card, and it exists only as a progress dot you could jump back to.
    expect(out).not.toContain('>Which tests should it come with?<');
    expect(out).not.toContain('End to end');
    expect(out).toContain('Question 2: Which tests should it come with?');
  });

  it('counts the steps so the card never feels open-ended', () => {
    expect(html()).toContain('1 of 2');
  });

  it('advances rather than sending while questions are left', () => {
    const out = html();
    expect(out).toContain('>Skip<');
    expect(out).not.toContain('Send answer');
  });

  it('sends outright when there is only one question, and offers no Back', () => {
    const out = html({ ...request, questions: [request.questions[0]!] });
    expect(out).toContain('Send answer');
    expect(out).not.toContain('>Back<');
    expect(out).toContain('1 question');
  });

  it('keeps descriptions on the card instead of hiding them in a tooltip', () => {
    // A wrapped grid of chips had to drop them to fit; a vertical list has room.
    expect(html()).toContain('Email a one-time link.');
  });

  it('says which shape the answer takes, so checkboxes never read as radios', () => {
    const out = html();
    expect(out).toContain('pick one');
    expect(out).toContain('role="radio"');

    const multi = html({ ...request, questions: [request.questions[1]!] });
    expect(multi).toContain('pick any');
    expect(multi).toContain('role="checkbox"');
  });

  it('always offers an answer that is not on the list', () => {
    expect(html()).toContain('Something else');
  });
});

const questions: AskQuestion[] = [
  { id: 'q1', header: 'Scope', question: 'How far?', options: [{ label: 'Parser' }, { label: 'Module' }] },
  {
    id: 'q2',
    header: 'Tests',
    question: 'Which tests?',
    options: [{ label: 'Unit' }, { label: 'E2E' }],
    multiSelect: true,
  },
];

describe('togglePick', () => {
  it('replaces the pick when only one answer is allowed', () => {
    expect(togglePick([], 'Parser', false)).toEqual(['Parser']);
    expect(togglePick(['Parser'], 'Module', false)).toEqual(['Module']);
  });

  it('clears a single-select pick when it is chosen again', () => {
    // Otherwise there is no way back to "unanswered" once a radio is touched,
    // and the card would force an answer the user did not mean to give.
    expect(togglePick(['Parser'], 'Parser', false)).toEqual([]);
  });

  it('accumulates when the options are not exclusive', () => {
    expect(togglePick(['Unit'], 'E2E', true)).toEqual(['Unit', 'E2E']);
    expect(togglePick(['Unit', 'E2E'], 'Unit', true)).toEqual(['E2E']);
  });

  it('does not mutate the array it was given', () => {
    const current = ['Unit'];
    togglePick(current, 'E2E', true);
    expect(current).toEqual(['Unit']);
  });
});

describe('toAnswers', () => {
  it('carries picks and typed text together', () => {
    const out = toAnswers(questions, { q2: ['Unit', 'E2E'] }, { q2: 'and a smoke test' });
    expect(out).toEqual([{ questionId: 'q2', labels: ['Unit', 'E2E'], note: 'and a smoke test' }]);
  });

  it('omits a question nobody touched rather than sending it blank', () => {
    // An entry with no labels and no note would read as "(not answered)" to the
    // model either way, but it would make isAskComplete call the card finished.
    const out = toAnswers(questions, { q1: ['Parser'] }, {});
    expect(out.map((a) => a.questionId)).toEqual(['q1']);
    expect(isAskComplete({ callId: 'c', askedAt: 0, questions }, out)).toBe(false);
  });

  it('treats whitespace as no answer at all', () => {
    expect(toAnswers(questions, {}, { q1: '   ' })).toEqual([]);
  });

  it('is complete once every question has something against it', () => {
    const out = toAnswers(questions, { q1: ['Module'] }, { q2: 'neither' });
    expect(isAskComplete({ callId: 'c', askedAt: 0, questions }, out)).toBe(true);
  });

  it('keeps a pick made on the last question in the same event as the send', () => {
    // The wizard sends from refs, not from the render that fired it: Enter on
    // the final question both chooses and sends, and reading the render-time
    // snapshot dropped the option the user had just hit Enter on.
    const live = { q1: ['Parser'] };
    const afterLastPick = { ...live, q2: togglePick([], 'E2E', true) };
    const out = toAnswers(questions, afterLastPick, {});
    expect(out).toContainEqual({ questionId: 'q2', labels: ['E2E'], note: undefined });
  });
});
