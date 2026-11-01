import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cssRule, stylesheet } from '../tests/css.js';
import { GreetingNekko, greetingGaze } from './GreetingNekko.js';

describe('Greeting Nekko', () => {
  it('tracks direction, remains bounded, and handles a coincident caret', () => {
    expect(greetingGaze(0, 0)).toEqual({ x: 0, y: 0 });
    expect(greetingGaze(1000, 0)).toEqual({ x: 2, y: 0 });
    expect(greetingGaze(-1000, 0)).toEqual({ x: -2, y: 0 });
    expect(greetingGaze(0, 1000)).toEqual({ x: 0, y: 2 });
    expect(greetingGaze(30, 0).x).toBeLessThan(2);
  });
  it('reuses the pixel peek with paws and no artificial ledge', () => {
    const markup = renderToStaticMarkup(<GreetingNekko />);
    expect(markup).toContain('viewBox="0 0 32 30"');
    expect(markup).toContain('class="peek-paws-slot" data-shown="true"');
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).toContain('data-part="peek-paws" transform="translate(0 50) scale(1 -1)"');
    expect(markup).toContain('data-part="peek-face" width="32" height="25" viewBox="0 0 32 25" overflow="hidden"');
    expect(markup.indexOf('</svg>')).toBeLessThan(markup.indexOf('data-part="peek-paws"'));
    expect(markup).toContain('data-nekko-look="true" transform="translate(0 1)"');
    expect(markup).not.toContain('d="M0 25H32');
    expect(markup).not.toContain('M15 20H17V21H15Z');
  });

  it('moves only the artwork 10px left and 1px up without changing its layout slot', () => {
    const css = stylesheet('styles.css');
    expect(cssRule(css, '.greeting-nekko')).toMatchObject({ left: '-18px', top: '14.5px', width: '80px', height: '75px' });
    expect(cssRule(css, '.greeting-nekko-slot')).toMatchObject({ width: '64px', height: '60px' });
  });

  it('offers a keyboard-accessible local laugh and inherits theme colors without network resources', () => {
    const markup = renderToStaticMarkup(<GreetingNekko />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('aria-label="Make Nekko laugh"');
    expect(markup).toContain('aria-pressed="false"');
    for (const token of ['--surface', '--ink']) expect(markup).toContain(`var(${token})`);
    expect(markup).not.toMatch(/href=|tabindex=|<image|<animate/);
  });
});

describe('Per-chat Nekko', () => {
  it('peeks over the composer with the greeting art, its hat, and the visibility toggle', async () => {
    const { ChatMascot } = await import('./ChatMascot.js');
    const markup = renderToStaticMarkup(<ChatMascot enabled working={false} wizardHat />);
    expect(markup).toContain('class="chat-mascot"');
    expect(markup).toContain('data-chat-mascot="idle"');
    expect(markup).toContain('data-part="peek-paws"');
    // Paws stay down until the composer has focus or a random peek.
    expect(markup).toContain('class="peek-paws-slot"><g');
    expect(markup).toContain('data-nekko-look="true"');
    expect(markup).toContain('orange-wizard-hat');
    expect(renderToStaticMarkup(<ChatMascot enabled working={false} wizardHat={false} />)).not.toContain('orange-wizard-hat');
    expect(renderToStaticMarkup(<ChatMascot enabled={false} working={false} wizardHat={false} />)).toBe('');
  });

  it('sits on the composer top-left with its chin on the edge, the plan sheet beside it', () => {
    const css = stylesheet('styles.css');
    expect(cssRule(css, '.chat-mascot')).toMatchObject({ position: 'absolute', left: '4px', top: '-62.5px', width: '80px', height: '75px' });
    expect(cssRule(css, '.composer-column:has(> .composer > .chat-mascot) .plan-sheet-dock')).toMatchObject({ 'margin-left': 'max(8%,92px)' });
  });
});
