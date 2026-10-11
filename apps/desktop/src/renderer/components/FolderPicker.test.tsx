import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../store.js', async (original) => {
  const actual = await original<typeof import('../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
import { useStore } from '../store.js';
import { FolderPicker, FolderPickerMenu } from './FolderPicker.js';

const folders = [
  { id: 'a', name: 'nekko-agent', path: '/code/nekko-agent', addedAt: 0 },
  { id: 'b', name: 'hypergate', path: '/code/hypergate', addedAt: 0 },
];

describe('composer folder picker', () => {
  it('names the primary folder, or says there is none', () => {
    const prev = useStore.getState();
    useStore.setState({ settings: { ...prev.settings, workspaces: folders } as any, sessions: [{ id: 's', workspaceId: 'a' } as any] });
    try {
      const out = renderToStaticMarkup(<FolderPicker sessionId="s" session={null} onChange={() => {}} />);
      expect(out).toContain('>nekko-agent<');
      expect(out).toContain('title="/code/nekko-agent"');
      expect(renderToStaticMarkup(<FolderPicker sessionId="other" session={null} onChange={() => {}} />)).toContain('>No folder<');
      expect(renderToStaticMarkup(<FolderPicker sessionId="s" session={null} disabled onChange={() => {}} />)).toContain('disabled=""');
    } finally { useStore.setState({ settings: prev.settings, sessions: prev.sessions }); }
  });

  it('lists a folder saved twice (any case or trailing slash) once', () => {
    const prev = useStore.getState();
    const dupes = [...folders, { id: 'c', name: 'code', path: 'C:\\Users\\p\\code', addedAt: 0 }, { id: 'd', name: 'code', path: 'c:\\users\\p\\code\\', addedAt: 0 }];
    useStore.setState({ settings: { ...prev.settings, workspaces: dupes } as any, sessions: [{ id: 's', workspaceId: 'c' } as any] });
    try {
      const out = renderToStaticMarkup(<FolderPicker sessionId="s" session={null} onChange={() => {}} />);
      expect(out).toContain('>code<');
    } finally { useStore.setState({ settings: prev.settings, sessions: prev.sessions }); }
  });

  it('keeps the menu open when a folder is revoked', async () => {
    const source = (await import('node:fs')).readFileSync(new URL('./FolderPicker.tsx', import.meta.url), 'utf8');
    const remove = source.slice(source.indexOf('const remove = '), source.indexOf('return (', source.indexOf('const remove = ')));
    expect(remove).not.toContain('setOpen(false)');
    expect(remove).not.toContain('run(');
  });

  it('checks the primary and marks supporting folders', () => {
    const out = renderToStaticMarkup(<FolderPickerMenu folders={folders} chat={{ workspaceId: 'a', supportingWorkspaceIds: ['b'] }} onPick={() => {}} onClear={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(out.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(out.indexOf('aria-checked="true"')).toBeLessThan(out.indexOf('nekko-agent'));
    expect(out).toContain('supporting');
    expect(out).toContain('Add folder…');
    expect(out).toContain('aria-label="Revoke access to nekko-agent"');
    expect(out).toContain('Revoke saved folder access, not delete files');
  });
});
