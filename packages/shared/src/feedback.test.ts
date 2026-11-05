import { describe, expect, it } from 'vitest';
import { FEEDBACK_MAX_CHARS, agentPrompt, appInfoLine, feedbackNote, feedbackNoteLength } from './feedback.js';

describe('feedback', () => {
  it('puts the choice, summary and description in the one message the server takes', () => {
    expect(feedbackNote('improve', ' The picker forgets ', ' It resets on restart. '))
      .toBe('Needs improvement: The picker forgets\n\nIt resets on restart.');
    expect(feedbackNote('good', 'Love the rail', 'It is quick.')).toBe('Good: Love the rail\n\nIt is quick.');
  });

  it('counts the whole note in code points, and nothing before anything is typed', () => {
    expect(feedbackNoteLength('good', '  ', '')).toBe(0);
    expect(feedbackNoteLength('good', 'Hi', 'There')).toBe('Good: Hi\n\nThere'.length);
    expect(feedbackNoteLength('good', '🐈', '🐈')).toBe('Good: x\n\nx'.length);
    const fits = 'a'.repeat(FEEDBACK_MAX_CHARS - 'Good: a\n\n'.length);
    expect(feedbackNoteLength('good', 'a', fits)).toBe(FEEDBACK_MAX_CHARS);
  });

  it('names the app in one line, skipping what is unknown', () => {
    expect(appInfoLine({ app: 'desktop', version: '1.4.0', os: 'macOS', osVersion: '15.1', arch: 'aarch64' }))
      .toBe('App: Nekko Agent 1.4.0 (desktop, macOS 15.1, aarch64)');
    expect(appInfoLine({ app: 'web', version: '1.4.0', os: 'Ubuntu' })).toBe('App: Nekko Agent 1.4.0 (web, Ubuntu)');
  });

  it('asks the agent to check with the person before filing, and ends with the app line', () => {
    const prompt = agentPrompt({ app: 'ios', version: '1.4.0', os: 'iOS', osVersion: '18.1', arch: 'arm64' });
    expect(prompt).toContain('File the issue only after I approve');
    expect(prompt).toContain('Leave out anything personal');
    expect(prompt.split('\n').at(-1)).toBe('App: Nekko Agent 1.4.0 (ios, iOS 18.1, arm64)');
    expect(agentPrompt(null)).not.toContain('App:');
  });
});
