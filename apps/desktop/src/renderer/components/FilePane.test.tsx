import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../store.js', () => ({ useStore: () => undefined }));
const { SaveState } = await import('./FilePane.js');

const at = new Date(2026, 10, 4, 9, 41).getTime();
const html = (props: Partial<React.ComponentProps<typeof SaveState>>) =>
  renderToStaticMarkup(<SaveState dirty={false} saving={false} saved={null} autoSave {...props} />);

describe('file editor save status', () => {
  it('says how a save happened and when', () => {
    expect(html({ saved: { at, kind: 'auto' } })).toMatch(/data-save-state="auto"[^>]*>.*Auto-saved<span[^>]*> at 9:41/);
    expect(html({ saved: { at, kind: 'manual' } })).toMatch(/data-save-state="manual"[^>]*>.*Saved<span[^>]*> at 9:41/);
    expect(html({ saved: { at, kind: 'clean' } })).toContain('All changes saved');
    expect(html({ saved: { at, kind: 'clean' } })).not.toContain(' at ');
  });

  it('announces writes in progress and pending edits', () => {
    expect(html({ saving: 'auto' })).toContain('Auto-saving…');
    expect(html({ saving: 'manual' })).toContain('Saving…');
    expect(html({ saving: 'auto' })).toContain('role="status"');
    expect(html({ dirty: true })).toContain('Saving shortly');
    expect(html({ dirty: true, autoSave: false })).toContain('Unsaved');
    expect(html({})).toBe('');
  });
});
