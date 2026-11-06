import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_MAX_CHARS, FEEDBACK_SCREENSHOT_MAX_BYTES, agentPrompt, appInfoLine, feedbackNote, feedbackNoteLength,
  feedbackScreenshotProblem, feedbackScreenshotType,
} from './feedback.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

describe('feedback', () => {
  it('knows a screenshot by its first bytes', () => {
    expect(feedbackScreenshotType(PNG)).toBe('image/png');
    expect(feedbackScreenshotType(JPEG)).toBe('image/jpeg');
    expect(feedbackScreenshotType(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(feedbackScreenshotType(new Uint8Array())).toBeNull();
  });

  it('takes PNG, JPG and JPEG up to exactly 5 MB', () => {
    for (const name of ['a.png', 'A.PNG']) expect(feedbackScreenshotProblem(name, 10, PNG)).toBeNull();
    for (const name of ['b.jpg', 'c.jpeg']) expect(feedbackScreenshotProblem(name, 10, JPEG)).toBeNull();
    expect(feedbackScreenshotProblem('a.png', FEEDBACK_SCREENSHOT_MAX_BYTES, PNG)).toBeNull();
    expect(feedbackScreenshotProblem('a.png', FEEDBACK_SCREENSHOT_MAX_BYTES + 1, PNG)).toBe('a.png is over the 5 MB limit.');
  });

  it('refuses other formats, and a file only named like an image', () => {
    expect(feedbackScreenshotProblem('a.gif', 10, new TextEncoder().encode('GIF89a'))).toBe("a.gif isn't a PNG or JPG file.");
    expect(feedbackScreenshotProblem('fake.png', 10, new TextEncoder().encode('not an image'))).toBe("fake.png isn't a PNG or JPG file.");
    expect(feedbackScreenshotProblem('real-png.gif', 10, PNG)).toBe("real-png.gif isn't a PNG or JPG file.");
  });

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
