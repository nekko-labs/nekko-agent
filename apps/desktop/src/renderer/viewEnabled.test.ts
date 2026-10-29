import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import './tests/browserGlobals.js';
import { liveStore } from './tests/liveStore.js';
import { renderApp } from './tests/renderApp.js';

vi.mock('./store.js', (original) => liveStore(original as never));
const { useStore, viewEnabled } = await import('./store.js');
const { LANGUAGES, translate } = await import('./i18n.js');
const settings = (developer: AppSettings['developer']) => ({ developer }) as AppSettings;

describe('navigation visibility', () => {
  it('keeps Agents available, including before settings load', () => {
    for (const value of [null, undefined, settings(undefined), settings({ serverControls: true })]) {
      expect(viewEnabled('command', value)).toBe(true);
    }
  });

  it('redirects attempts to open a disabled view to Agents', () => {
    useStore.setState({ settings: settings(undefined), view: 'settings' });
    useStore.getState().setView('training');
    expect(useStore.getState().view).toBe('command');
  });

  it('preserves the existing experimental-view conventions', () => {
    for (const view of ['training', 'design', 'memory'] as const) {
      expect(viewEnabled(view, settings(undefined))).toBe(false);
      expect(viewEnabled(view, { ...settings(undefined), experimental: { [view]: true } })).toBe(true);
    }
  });

  it('names Agents in every shipped locale', () => {
    expect(translate('en', 'nav.command')).toBe('Agents');
    for (const { code } of LANGUAGES) expect(translate(code, 'nav.command')).not.toBe('nav.command');
  });

  it('uses the still, eyeless cat for Agents and offers no Chat page in either rail', async () => {
    const off = await renderApp({});
    const agents = off.slice(off.indexOf('aria-label="Agents"'), off.indexOf('</button>', off.indexOf('aria-label="Agents"')));
    expect(agents).toContain('pixel-stationary');
    expect(agents).toContain('data-part="pixel-head"');
    expect(agents).not.toContain('pixel-eyes');
    expect(off.match(/aria-label="Agents"/g)).toHaveLength(2);
    expect(off).not.toContain('aria-label="Chat"');
  });
});
