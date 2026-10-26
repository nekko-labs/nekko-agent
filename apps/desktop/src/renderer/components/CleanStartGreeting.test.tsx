import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CleanStartGreeting, GREETING_QUESTIONS, GREETING_ROTATE_MS } from './CleanStartGreeting.js';

describe('Clean-start greeting', () => {
  it('centers one decorative cat immediately before the welcoming question', () => {
    const html = renderToStaticMarkup(<CleanStartGreeting />);
    expect(html.indexOf('greeting-nekko')).toBeLessThan(html.indexOf('<h2>'));
    expect(html).toContain('<h2>What should we work on?</h2>');
    expect(html).not.toMatch(/aria-live|role="status"/);
  });
  it('has varied local questions and a calm rotation cadence', () => {
    expect(GREETING_QUESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(GREETING_QUESTIONS).size).toBe(GREETING_QUESTIONS.length);
    expect(GREETING_QUESTIONS.every(q => q.endsWith('?'))).toBe(true);
    expect(GREETING_ROTATE_MS).toBe(8000);
  });
});
