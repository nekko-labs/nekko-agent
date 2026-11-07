import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { ContextChangeNotice, showContextChangeNotice } from './ContextChangeNotice.js';

vi.mock('../store.js', () => ({ useStore: { getState: () => ({ settings: {} }), setState: vi.fn() } }));
vi.mock('./primitives/Modal.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

const html = (tokens?: number) => renderToStaticMarkup(<ContextChangeNotice tokens={tokens} onClose={() => {}} />);

describe('next-turn context notice', () => {
  it('defaults on for new and existing settings, and honors both explicit choices', () => {
    for (const settings of [null, undefined, {}, { developer: {} }, { developer: { serverControls: true } }, { developer: { showContextChangeNotice: true } }]) {
      expect(showContextChangeNotice(settings as AppSettings | null | undefined)).toBe(true);
    }
    expect(showContextChangeNotice({ developer: { showContextChangeNotice: false } } as AppSettings)).toBe(false);
  });
  it('leads with approximate input tokens for the next turn, not an immediate charge', () => {
    const text = html(106143);
    expect(text).toContain('106,143 input tokens');
    expect(text).toContain('Your next turn with this selection will use about');
    expect(text).toContain('open a new chat instead');
    expect(text).toContain('Nothing is sent until your next turn');
    expect(text).toContain('provider caching and billing');
  });
  it('distinguishes unavailable estimates from zero', () => {
    expect(html()).toContain('estimate is unavailable');
    expect(html()).not.toContain('0 input tokens');
    expect(html(0)).toContain('0 input tokens');
  });
  it('offers opt-in suppression and explains how to restore the notice', () => {
    const text = html(12);
    expect(text).toContain('type="checkbox"');
    expect(text).not.toContain('checked=""');
    expect(text).toContain('Got it. Don’t show me again.');
    expect(text).toContain('Settings → System → Developer');
  });
});
