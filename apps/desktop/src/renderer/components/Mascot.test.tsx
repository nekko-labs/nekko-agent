import React from 'react';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, cssValue, stylesheet } from '../tests/css.js';
import { liveStore } from '../tests/liveStore.js';
import { renderApp } from '../tests/renderApp.js';
vi.mock('../store.js', (original) => liveStore(original as never));
import { Mascot, MiniNekko, NekkoAvatar } from './Mascot.js';
import { LANGUAGES, translate } from '../i18n.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Pixel Nekko', () => {
  it('is decorative by default and accessible when titled', () => {
    const decorative = renderToStaticMarkup(<NekkoAvatar />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).toContain('role="presentation"');
    const labelled = renderToStaticMarkup(<NekkoAvatar title="Nekko" />);
    expect(labelled).toContain('aria-label="Nekko"');
    expect(labelled).toContain('role="img"');
    expect(labelled).not.toContain('aria-hidden');
  });

  it.each([16, 18, 24, 28, 40, 64])('keeps a square grid at %spx', (size) => {

    const markup = renderToStaticMarkup(<NekkoAvatar size={size} />);
    expect(markup).toContain(`width="${size}" height="${size}"`);
    expect(markup).toContain('viewBox="0 0 32 32"');
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('fill="#101714"');
    expect(markup).toContain('stroke="#f2f1e9"');
  });

  it('shares the head and all eye frames across desktop surfaces without spy accessories', () => {
    for (const markup of [renderToStaticMarkup(<NekkoAvatar />), renderToStaticMarkup(<MiniNekko />), renderToStaticMarkup(<Mascot mood="idle" enabled />)]) {
      expect(markup.match(/data-part="pixel-head"/g)).toHaveLength(1);
      for (const eye of ['open', 'happy', 'closed']) expect(markup).toContain(`pixel-eyes-${eye}`);
      expect(markup).not.toMatch(/sunglasses|earpiece|collar|tie|slender-body|filter=/);

    }
  });

  it('only adds the orange wizard hat when explicitly requested', () => {
    expect(renderToStaticMarkup(<NekkoAvatar wizardHat />)).toContain('orange-wizard-hat');
    expect(renderToStaticMarkup(<NekkoAvatar />)).not.toContain('orange-wizard-hat');
    expect(renderToStaticMarkup(<MiniNekko />)).not.toContain('orange-wizard-hat');
  });
  it('puts the Spooky wizard hat on the corner mascot only', async () => {
    expect(renderToStaticMarkup(<Mascot mood="idle" enabled wizardHat />)).toContain('orange-wizard-hat');
    expect(renderToStaticMarkup(<Mascot mood="idle" enabled />)).not.toContain('orange-wizard-hat');
    // In the app: the Spooky (autumn) preset dresses the corner mascot, and nothing else.
    const spooky = await renderApp({ themePreset: 'autumn' } as never);
    expect(spooky.match(/orange-wizard-hat/g)).toHaveLength(1);
    const mascot = spooky.slice(spooky.indexOf('class="pixel-mascot'));
    expect(mascot.slice(0, mascot.indexOf('</button>'))).toContain('orange-wizard-hat');
    expect(await renderApp({})).not.toContain('orange-wizard-hat');
  });
  it('wears the wizard hat smaller and higher, on the crown', () => {
    expect(renderToStaticMarkup(<NekkoAvatar wizardHat />)).toContain('transform="translate(16.5 9) scale(0.8) translate(-16.5 -12)"');
  });
  it('draws the nav rail Agents cat without eyes', () => {
    const eyeless = renderToStaticMarkup(<NekkoAvatar eyes={false} />);
    expect(eyeless).toContain('data-part="pixel-head"');
    expect(eyeless).not.toContain('pixel-eyes');
    // Its use on the Agents rail button is rendered in viewEnabled.test.ts.
  });
  it('keeps working feedback, greeting, and the visibility setting', () => {
    expect(renderToStaticMarkup(<MiniNekko size={16} />)).toContain('pixel-working');
    const working = renderToStaticMarkup(<Mascot mood="thinking" working enabled />);
    expect(working).toContain('data-mascot-pose="working"');
    expect(working).toContain('Nekko is working');
    expect(working).toContain('<button type="button"');
    expect(renderToStaticMarkup(<Mascot mood="waving" enabled />)).toContain('data-mascot-pose="happy"');
    expect(renderToStaticMarkup(<Mascot mood="idle" enabled={false} />)).toBe('');
  });

  it('ignores stale per-chat thinking mood and uses a steady aggregate working pose', () => {
    expect(renderToStaticMarkup(<Mascot mood="thinking" enabled />)).toContain('data-mascot-pose="idle"');
    const active = renderToStaticMarkup(<Mascot mood="idle" working enabled />);
    expect(active).toContain('data-mascot-pose="working"');
    expect(active).toContain('pixel-stationary');
    expect(active).not.toContain('pixel-quiet');
    expect(cssRule(stylesheet('styles.css'), '.pixel-mascot[data-mascot-pose="working"] [data-part="pixel-head"] > path:first-child')).toMatchObject({ fill: 'var(--accent)', stroke: 'var(--accent)' });
  });

  it('uses matching head and eye geometry on marketing', () => {
    const desktop = source('./Mascot.tsx');
    const website = source('../../../../../apps/website/index.html');
    const paths = [...desktop.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
    expect(paths).toHaveLength(5);
    for (const path of paths) {
      expect(website).toContain(path);
    }
  });

  it('provides stepped motion and reduced-motion guards on desktop and the website', () => {
    const website = postcss.parse(source('../../../../../apps/website/styles.css'));
    for (const css of [stylesheet('styles.css'), website]) {
      expect(cssRule(css, '.pixel-nekko').animation).toMatch(/steps\(1,end\)/);
      for (const selector of ['.pixel-nekko', '.pixel-nekko *']) {
        expect(cssRule(css, selector, { media: 'prefers-reduced-motion: reduce' }).animation, selector).toBe('none !important');
      }
    }
  });

  it('pauses desktop motion with page visibility', () => {
    expect(source('./Mascot.tsx')).toMatch(/document\.addEventListener\('visibilitychange'/);
  });

  it('keeps navigation still and limits the quiet face to the corner mascot', () => {
    expect(renderToStaticMarkup(<NekkoAvatar stationary />)).toContain('pixel-stationary');
    expect(renderToStaticMarkup(<NekkoAvatar />)).not.toContain('pixel-quiet');
    expect(renderToStaticMarkup(<Mascot mood="idle" enabled />)).toContain('pixel-quiet');
    const css = stylesheet('styles.css');
    for (const selector of ['.pixel-stationary', '.pixel-stationary *']) expect(cssRule(css, selector).animation).toBe('none !important');
    expect(cssRule(css, '.pixel-quiet .pixel-mouth').display).toBe('none');
    expect(cssRule(css, '.pixel-mascot .pixel-quiet').animation).toBe(cssValue('pixel-quiet-hop 30s steps(1, end) infinite'));
    expect(cssRule(css, '.pixel-mascot .pixel-quiet .pixel-eyes-open')).toMatchObject({ opacity: '0', animation: cssValue('pixel-quiet-open 24s steps(1, end) infinite') });
    expect(cssRule(css, '.pixel-mascot .pixel-quiet .pixel-eyes-closed').opacity).toBe('0');
  });

  it('preserves translated mascot settings', () => {
    for (const { code } of LANGUAGES) expect(translate(code, 'settings.mascot')).toContain('Nekko');
  });
});
