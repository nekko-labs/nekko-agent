import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@nekko-agent/shared';
import { ContextChangeNotice, showContextChangeNotice } from './ContextChangeNotice.js';

vi.mock('../store.js', () => ({ useStore: { getState: () => ({ settings: {} }), setState: vi.fn() } }));
vi.mock('./primitives/Modal.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

const html = (tokens?: number) => renderToStaticMarkup(<ContextChangeNotice tokens={tokens} change="model" hasAttachments={false} onClose={() => {}} onMove={async () => {}} />);

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
    expect(text).toContain('Changing models resends this chat’s history on your next turn');
    expect(text).toContain('The new chat won’t have this history.');
    expect(text).toContain('Move to new chat');
    expect(text).toContain('Got it');
  });
  it('distinguishes unavailable estimates from zero', () => {
    expect(html()).toContain('estimate is unavailable');
    expect(html()).not.toContain('0 input tokens');
    expect(html(0)).toContain('0 input tokens');
  });
  it('offers opt-in suppression and explains how to restore the notice', () => {
    const text = html(12);
    expect(text).toContain('role="switch"');
    expect(text).not.toContain('aria-checked="true"');
    expect(text).toContain('Don’t show me again');
    expect(text).toContain('Settings → System → Developer');
  });
});
