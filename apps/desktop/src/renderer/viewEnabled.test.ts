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
  it('keeps Agents available while Chat is default-off, including before settings load', () => {
    for (const value of [null, undefined, settings(undefined), settings({ serverControls: true }), settings({ chat: false })]) {
      expect(viewEnabled('command', value)).toBe(true);
      expect(viewEnabled('chat', value)).toBe(false);
    }
    expect(viewEnabled('chat', settings({ chat: true }))).toBe(true);
  });

  it('redirects attempts to open disabled Chat to Agents', () => {
    useStore.setState({ settings: settings({ chat: false }), view: 'settings' });
    useStore.getState().setView('chat');
    expect(useStore.getState().view).toBe('command');
    useStore.setState({ settings: settings({ chat: true }) });
    useStore.getState().setView('chat');
    expect(useStore.getState().view).toBe('chat');
  });

  it('preserves the existing experimental-view conventions', () => {
    for (const view of ['training', 'design', 'memory'] as const) {
      expect(viewEnabled(view, settings({ chat: true }))).toBe(false);
      expect(viewEnabled(view, { ...settings(undefined), experimental: { [view]: true } })).toBe(true);
    }
  });

  it('renames both destinations in every shipped locale', () => {
    expect(translate('en', 'nav.command')).toBe('Agents');
    expect(translate('en', 'nav.chat')).toBe('Chat');
    for (const { code } of LANGUAGES) {
      expect(translate(code, 'nav.command')).not.toBe('nav.command');
      expect(translate(code, 'nav.chat')).not.toBe('nav.chat');
      expect(translate(code, 'nav.command')).not.toBe(translate(code, 'nav.chat'));
    }
  });

  it('uses the still, eyeless cat for Agents and filters both rails with viewEnabled', async () => {
    const off = await renderApp({ developer: { chat: false } });
    const agents = off.slice(off.indexOf('aria-label="Agents"'), off.indexOf('</button>', off.indexOf('aria-label="Agents"')));
    expect(agents).toContain('pixel-stationary');
    expect(agents).toContain('data-part="pixel-head"');
    expect(agents).not.toContain('pixel-eyes');
    // Chat is off: neither the side rail nor the phone tabs offer it.
    expect(off.match(/aria-label="Agents"/g)).toHaveLength(2);
    expect(off).not.toContain('aria-label="Chat"');
    const on = await renderApp({ developer: { chat: true } });
    expect(on.match(/aria-label="Chat"/g)).toHaveLength(2);
  });
});
