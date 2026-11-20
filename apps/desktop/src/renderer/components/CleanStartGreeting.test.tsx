import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanStartGreeting, GREETING_QUESTIONS, PHOTO_GREETINGS, greetingForChat } from './CleanStartGreeting.js';

afterEach(() => vi.useRealTimers());
describe('Clean-start greeting', () => {
  it('centers one decorative cat immediately before the welcome text', () => {
    const html = renderToStaticMarkup(<CleanStartGreeting />);
    expect(html.indexOf('greeting-nekko')).toBeLessThan(html.indexOf('<h2>'));
    expect(html).toContain('<h2>What should we work on?</h2>');
    expect(html).not.toMatch(/aria-live|role="status"/);
  });
  it('has a broad set of unique casual local greetings', () => {
    expect(GREETING_QUESTIONS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(GREETING_QUESTIONS).size).toBe(GREETING_QUESTIONS.length);
    expect(GREETING_QUESTIONS).toContain('What’s next?');
    expect(GREETING_QUESTIONS).toContain('It’s building time.');
  });
  it('keeps the same greeting across time and remounts, without a timer', () => {
    vi.useFakeTimers();
    const render = () => renderToStaticMarkup(<CleanStartGreeting sessionId="chat-a" createdAt={new Date(2026, 5, 1, 7).getTime()} />);
    const before = render();
    vi.advanceTimersByTime(86400000);
    expect(render()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('varies greetings by chat identity', () => {
    expect(new Set(Array.from({ length: 100 }, (_, i) => greetingForChat(`chat-${i}`))).size).toBeGreaterThan(20);
  });
  it('uses the chat creation time for morning and night copy', () => {
    const phrases = (hour: number) => new Set(Array.from({ length: 200 }, (_, i) => greetingForChat(`chat-${i}`, new Date(2026, 5, 1, hour).getTime())));
    expect(phrases(7)).toContain('Morning, early bird.');
    expect(phrases(23)).toContain('Hey there, night owl.');
    expect(phrases(14)).not.toContain('Morning, early bird.');
    expect(phrases(14)).not.toContain('Hey there, night owl.');
  });
});

describe('Photo clean-start greeting', () => {
  it('asks about the picture, stays stable per chat, and fits one line', () => {
    expect(PHOTO_GREETINGS).toContain(greetingForChat('photo-chat', 0, 'photo'));
    expect(greetingForChat('photo-chat', 0, 'photo')).toBe(greetingForChat('photo-chat', Date.now(), 'photo'));
    const longest = Math.max(...GREETING_QUESTIONS.map((g) => g.length));
    for (const g of PHOTO_GREETINGS) expect(g.length).toBeLessThanOrEqual(longest);
  });
  it('shows a given title instead of a greeting', () => {
    expect(renderToStaticMarkup(<CleanStartGreeting kind="photo" title="Let’s get photo mode set up." />)).toContain('<h2>Let’s get photo mode set up.</h2>');
  });
});
