import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Mascot, MiniNekko, NekkoAvatar } from './Mascot.js';
import { LANGUAGES, translate } from '../i18n.js';

vi.mock('../store.js', () => ({ useStore: vi.fn() }));

const poseOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => actual.useState(
      poseOverride.value && (initial === 'waking' || initial === 'bug') ? poseOverride.value as T : initial,
    ),
  };
});

function renderPose(pose: string): string {
  poseOverride.value = pose;
  try {
    return renderToStaticMarkup(<Mascot mood={pose === 'bug' ? 'thinking' : 'idle'} enabled />);
  } finally {
    poseOverride.value = null;
  }
}

const OLD_BODY_PATHS = [
  'M 27 50 C 33 42 46 40 61 44',
  'M 28 48 C 31 37 42 33 52 38',
  'M 44 43 C 51 38 64 39 73 45',
  'M 32 44 C 37 41 43 42 48 40',
];

describe('Nekko branding', () => {
  it('keeps the outline portrait accessible and decorative by default', () => {
    const decorative = renderToStaticMarkup(<NekkoAvatar />);
    expect(decorative).toContain('role="presentation"');
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).toContain('viewBox="15 3.5 36 53"');
    expect(decorative).toContain('stroke="var(--ink)"');
    expect(decorative).toContain('fill="var(--paper)"');
    expect(decorative).toContain('#f0a35e');
    const labelled = renderToStaticMarkup(<NekkoAvatar size={40} title="Nekko" />);
    expect(labelled).toContain('aria-label="Nekko"');
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('width="40"');
    expect(labelled).not.toContain('aria-hidden');
  });

  it('keeps the mini working indicator and full activity poses', () => {
    const mini = renderToStaticMarkup(<MiniNekko />);
    expect(mini).toContain('nekko-mini-blink');
    expect(mini).toContain('data-part="pixel-head"');
    const waking = renderToStaticMarkup(<Mascot mood="idle" enabled />);
    expect(waking).toContain('data-mascot-pose="waking"');
    expect(waking).toContain('aria-label="Nekko is getting up"');
    expect(waking).toContain('nekko-stand');
    expect(waking).toContain('pointer-events-auto cursor-pointer');
    expect(waking).not.toContain('md:pointer-events-auto');
    expect(waking).toContain('id="nekko-boil"');
    expect(waking).toContain('dur="0.55s"');
    const working = renderToStaticMarkup(<Mascot mood="thinking" enabled />);
    expect(working).toContain('data-mascot-pose="bug"');
    expect(working).toContain('aria-label="Nekko spotted a bug"');
    expect(working).toContain('nekko-bug-watch');
    expect(renderToStaticMarkup(<Mascot mood="thinking" enabled={false} />)).toBe('');
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    for (const token of ['wake', 'breathe', 'stretch', 'bug-watch', 'sleep', 'zs', 'paused', 'boil']) {
      expect(css).toContain(`.nekko-${token}`);
    }
    expect(css).toContain('filter: url(#nekko-boil)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('aphelion-');
    expect(mini + waking + working).not.toContain('aphelion-');
  });

  it.each(['waking', 'lying', 'stretching', 'bug', 'sleeping'])('keeps %s feline with discreet agent accessories', (pose) => {
    const markup = renderPose(pose);
    expect(markup).toContain(`data-mascot-pose="${pose}"`);
    expect(markup).toContain('data-part="agent-head"');
    for (const accessory of ['sunglasses', 'earpiece', 'wire', 'collar', 'tie']) {
      expect(markup.match(new RegExp(`data-mascot-accessory="${accessory}"`, 'g'))).toHaveLength(1);
    }
    const sleeping = pose === 'sleeping' || pose === 'stretching';
    expect(markup).toContain(`data-position="${sleeping ? 'perched' : 'worn'}"`);
    expect(markup.includes('data-part="closed-eyes"')).toBe(sleeping);
    expect(markup).toContain('fill="var(--paper)"');
    expect(markup).toContain('stroke="var(--ink)"');
    expect(markup).toContain('#f0a35e');
    expect(markup).not.toContain('M 20.2 20.5 Q 23.6 15 29.3 14');
  });

  it.each(['waking', 'lying', 'stretching', 'bug', 'sleeping'])('uses one modest line-only stick body for %s', (pose) => {
    const markup = renderPose(pose);
    expect(markup.match(/data-part="slender-body"/g)).toHaveLength(1);
    expect(markup.match(/data-part="torso"/g)).toHaveLength(1);
    expect(markup).toContain('data-body-style="line-only"');
    const width = Number(markup.match(/data-torso-width="([\d.]+)"/)?.[1]);
    expect(width).toBeGreaterThanOrEqual(8);
    expect(width).toBeLessThanOrEqual(16);
    expect(markup).toMatch(/data-part="torso"[^>]+fill="none"/);
    for (const path of OLD_BODY_PATHS) expect(markup).not.toContain(path);
  });

  it('leans the default body against a short edge with crossed ankles', () => {
    const markup = renderPose('lying');
    expect(markup).toContain('data-stance="leaning"');
    expect(markup.match(/data-part="edge"/g)).toHaveLength(1);
    expect(markup.match(/data-part="edge-contact"/g)).toHaveLength(1);
    expect(markup.match(/data-part="crossed-ankles"/g)).toHaveLength(1);
    expect(markup).toContain('data-edge-length="62"');
  });

  it('keeps slender torso widths consistent across every activity pose', () => {
    const widths = ['waking', 'lying', 'stretching', 'bug', 'sleeping'].map((pose) =>
      Number(renderPose(pose).match(/data-torso-width="([\d.]+)"/)?.[1]),
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(4);
  });

  it.each([22, 24, 28, 30, 34, 40])('includes a collar and safe accessory bounds in the %spx portrait', (size) => {
    const markup = renderToStaticMarkup(<NekkoAvatar size={size} />);
    expect(markup).toContain(`width="${size}"`);
    expect(markup).toContain(`height="${(size * 53) / 36}"`);
    expect(markup).toContain('viewBox="15 3.5 36 53"');
    for (const accessory of ['sunglasses', 'earpiece', 'wire', 'collar', 'tie']) {
      expect(markup).toContain(`data-mascot-accessory="${accessory}"`);
    }
  });

  it.each([16, 18, 24])('simplifies the %spx mini without losing its working animation', (size) => {
    const markup = renderToStaticMarkup(<MiniNekko size={size} />);
    expect(markup).toContain(`width="${size}" height="${size}"`);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('data-part="pixel-head"');
    expect(markup).toContain('data-mini-state="idle"');
    expect(markup).toContain('viewBox="0 0 32 32"');
    expect(markup).toContain('nekko-mini-blink');
    expect(markup).not.toContain('data-mascot-accessory');
    for (const accessory of ['wire', 'collar', 'tie']) {
      expect(markup).not.toContain(`data-mascot-accessory="${accessory}"`);
    }
  });

  it('keeps the original activity durations and hidden/reduced-motion guards', () => {
    const source = readFileSync(new URL('./Mascot.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const AFK_MS = 60_000;');
    expect(source).toContain('const STRETCH_MS = 12_000;');
    expect(source).toContain("pose === 'waking' ? 1500 : 1900");
    expect(source).toContain("const t = setTimeout(() => setPeek(true), 400);");
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.nekko-paused, .nekko-paused * { animation-play-state: paused !important; }');
    expect(css).toContain('.nekko-paused .nekko-boil { filter: none; }');
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n  .nekko-boil { filter: none; }');
  });

  it('updates every shipped mascot locale without changing translation keys', () => {
    expect(LANGUAGES.map(({ code }) => code)).toEqual(['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh']);
    for (const { code } of LANGUAGES) {
      const label = translate(code, 'settings.mascot');
      expect(label).toContain('Nekko');
      expect(label).not.toContain('Aphelion');
    }
    expect(translate('unsupported', 'settings.mascot')).toBe('Show Nekko mascot');
    expect(translate('en', 'missing.key')).toBe('missing.key');
  });
});
