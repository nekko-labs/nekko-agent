import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cssRule, hasKeyframes, stylesheet } from '../tests/css.js';
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
    // The window reaches above the ears (for the hat and the "!") with the same
    // mapping, and still cuts him off at the composer edge, 25 units down.
    expect(markup).toContain('data-part="peek-face" y="-12" width="32" height="37" viewBox="0 -12 32 37" overflow="hidden"');
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

  // Source pin: an approval arrives from the host, which a server render never
  // applies. His head sits 62.5px over the composer, right where the approval
  // bar puts Deny, so he ducks behind the composer until the user has answered.
  it('ducks while an approval waits, so he never covers Deny (source pin)', () => {
    const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/<ChatMascot\s+enabled=\{settings\?\.mascotEnabled \?\? true\}\s+away=\{!!approval\}/);
  });

  it('looks alarmed and ducks when an approval arrives, then pops back up smiling', async () => {
    const { nextMascotPose } = await import('./ChatMascot.js');
    expect(nextMascotPose('here', true)).toBe('ducking');
    expect(nextMascotPose('popping', true)).toBe('ducking');
    expect(nextMascotPose('away', true)).toBe('away');
    expect(nextMascotPose('ducking', false)).toBe('popping');
    expect(nextMascotPose('away', false)).toBe('popping');
    expect(nextMascotPose('here', false)).toBe('here');
  });

  it('is already down, alarmed and pawless when he arrives with an approval waiting', async () => {
    const { ChatMascot } = await import('./ChatMascot.js');
    const markup = renderToStaticMarkup(<ChatMascot enabled working={false} wizardHat={false} away />);
    expect(markup).toContain('data-chat-mascot-pose="away"');
    expect(markup).toContain('data-nekko-face="alert"');
    expect(markup).toContain('fill="var(--warning)"');
    expect(markup).not.toContain('data-nekko-look');
    expect(markup).toContain('class="peek-paws-slot"><g');
    // He stays mounted, so his gaze and paw state are kept for his return.
    expect(renderToStaticMarkup(<ChatMascot enabled working={false} wizardHat={false} />)).not.toContain('data-chat-mascot-pose');
  });

  it('draws the alarm pose of the low-memory card and the laugh\'s ^ ^ eyes as a smile', async () => {
    const { PeekNekkoArt } = await import('./GreetingNekko.js');
    // Read as text: the main process module imports Electron.
    const main = readFileSync(new URL('../../main/memoryWatch.ts', import.meta.url), 'utf8');
    const card = main.slice(main.indexOf('export const ALERT_MASCOT'), main.indexOf('</svg>', main.indexOf('export const ALERT_MASCOT')));
    const parts = [...card.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
    expect(parts).toHaveLength(4);
    const alert = renderToStaticMarkup(<PeekNekkoArt className="x" look={{ x: 0, y: 0 }} face="alert" />);
    // Every part but the nose (the peek face has none) is the same pixels.
    for (const d of parts.filter((d) => d !== 'M15 20H17V21H15Z')) expect(alert).toContain(`d="${d}"`);
    expect(alert).toContain('overflow="visible"');
    const smile = renderToStaticMarkup(<PeekNekkoArt className="x" look={{ x: 0, y: 0 }} face="smile" />);
    expect(smile).toContain('data-nekko-face="smile"');
    expect(smile).toContain('M10 17V15H11V14H13V15H14V17H13V16H11V17Z');
    expect(smile).not.toContain('M14 20H19V22H18V23H15V22H14Z');
    // The hat goes down with him, inside the window that cuts him off.
    const hat = renderToStaticMarkup(<PeekNekkoArt className="x" look={{ x: 0, y: 0 }} face="alert" wizardHat />);
    expect(hat.indexOf('orange-wizard-hat')).toBeGreaterThan(hat.indexOf('data-part="peek-head"'));
    expect(hat.indexOf('orange-wizard-hat')).toBeLessThan(hat.indexOf('data-part="peek-paws"'));
  });

  it('sinks the whole head below the edge, quickly back, and without motion when reduced', () => {
    const css = stylesheet('styles.css');
    for (const pose of ['ducking', 'away']) {
      expect(cssRule(css, `.chat-mascot[data-chat-mascot-pose="${pose}"] [data-part="peek-head"]`)).toMatchObject({ transform: 'translateY(34px)' });
    }
    const motion = { media: 'prefers-reduced-motion: no-preference' };
    expect(cssRule(css, '.chat-mascot[data-chat-mascot-pose="ducking"] [data-part="peek-head"]', motion)).toMatchObject({ animation: 'chat-mascot-duck 760ms both' });
    expect(cssRule(css, '.chat-mascot[data-chat-mascot-pose="popping"] [data-part="peek-head"]', motion)).toMatchObject({ animation: 'chat-mascot-pop 260ms both' });
    expect(hasKeyframes(css, 'chat-mascot-duck')).toBe(true);
    expect(hasKeyframes(css, 'chat-mascot-pop')).toBe(true);
  });
});
