import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AskRequest } from '@nekko-agent/shared';
import { ClipPicker, clipAnswers, clipTotal, suggestedPicks } from './ClipPicker.js';
import { QuestionCard } from './QuestionCard.js';

const opt = (label: string) => ({ label, description: '' });
const request: AskRequest = {
  callId: 'c_veo-clip', askedAt: 1,
  questions: [
    { id: 'q1', header: 'Length', question: 'How long should the clip be?', options: [opt('4 seconds'), opt('6 seconds'), opt('8 seconds')] },
    { id: 'q2', header: 'Audio', question: 'Should the clip have sound?', options: [opt('No audio'), opt('With audio')] },
    { id: 'q3', header: 'Resolution', question: 'At which resolution?', options: [opt('720p'), opt('1080p')] },
  ],
  clip: { model: 'Veo 3.1', via: 'OpenRouter', sendsPicture: false, prices: {
    '4 seconds|No audio|720p': 0.8, '6 seconds|No audio|720p': 1.2, '6 seconds|With audio|720p': 2.4, '8 seconds|With audio|1080p': 3.2,
  } },
} as AskRequest;

describe('ClipPicker', () => {
  it('starts on the suggested clip, the first option of each question', () => {
    expect(suggestedPicks(request)).toEqual({ q1: '4 seconds', q2: 'No audio', q3: '720p' });
    expect(clipTotal(request, suggestedPicks(request))).toBe(0.8);
  });

  it('prices each combination the user picks, and says when one is not priced', () => {
    expect(clipTotal(request, { q1: '6 seconds', q2: 'With audio', q3: '720p' })).toBe(2.4);
    expect(clipTotal(request, { q1: '8 seconds', q2: 'No audio', q3: '1080p' })).toBeNull();
  });

  it('answers with the picks and the confirmed total', () => {
    expect(clipAnswers(request, { q1: '6 seconds', q2: 'With audio', q3: '720p' }, 2.4)).toEqual([
      { questionId: 'q1', labels: ['6 seconds'] },
      { questionId: 'q2', labels: ['With audio'] },
      { questionId: 'q3', labels: ['720p'] },
      { questionId: 'total', labels: ['2.40'] },
    ]);
  });

  it('shows every choice at once, the total, the warning and a priced button', () => {
    const html = renderToStaticMarkup(<ClipPicker request={request} onAnswer={() => {}} onSkip={() => {}} />);
    expect(html).toContain('Make a clip with Veo 3.1');
    for (const label of ['4 seconds', '8 seconds', 'With audio', '1080p']) expect(html).toContain(`data-clip-option="${label}"`);
    expect(html).toContain('$0.80');
    expect(html).toContain('Make clip · $0.80');
    expect(html).toContain('cannot be stopped');
    expect(html).toContain('aria-checked="true" data-clip-option="4 seconds"');
  });

  it('is what a question card shows for a clip, and only for a clip', () => {
    expect(renderToStaticMarkup(<QuestionCard request={request} onAnswer={() => {}} onSkip={() => {}} />)).toContain('data-clip-picker');
    const plain = { ...request, clip: undefined };
    expect(renderToStaticMarkup(<QuestionCard request={plain} onAnswer={() => {}} onSkip={() => {}} />)).not.toContain('data-clip-picker');
  });
});
