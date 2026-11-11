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

  it('summarizes primary and supporting folders without duplicating the primary', () => {
    const prev = useStore.getState();
    useStore.setState({ settings: { ...prev.settings, workspaces: folders } as any, sessions: [{ id: 's', workspaceId: 'a', supportingWorkspaceIds: ['a', 'b', 'gone'] } as any] });
    try {
      const html = renderToStaticMarkup(<FolderPicker sessionId="s" session={null} selectedSummary onChange={() => {}} />);
      expect(html).toContain('Environment: nekko-agent, hypergate');
      expect(html).toContain('>nekko-agent, hypergate<');
      expect(html).toContain('/code/hypergate');
      expect(html).not.toContain('gone');
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

  // Source pin, pending a composer e2e journey: the revoke handler lives in the
  // open (portalled) menu's click path, which a server render never reaches.
  it('keeps the menu open when a folder is revoked (source pin)', async () => {
    const source = (await import('node:fs')).readFileSync(new URL('./FolderPicker.tsx', import.meta.url), 'utf8');
    const remove = source.match(/const remove = [^]*?\n {2}\};/)?.[0] ?? '';
    expect(remove).toContain('removeWorkspace');
    expect(remove).not.toMatch(/setOpen\(\s*false\s*\)/);
    expect(remove).not.toMatch(/\brun\(/);
  });

  it('checks the primary and marks supporting folders', () => {
    const out = renderToStaticMarkup(<FolderPickerMenu folders={folders} chat={{ workspaceId: 'a', supportingWorkspaceIds: ['b'] }} onPick={() => {}} onClear={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(out.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(out.indexOf('aria-checked="true"')).toBeLessThan(out.indexOf('nekko-agent'));
    expect(out).toContain('supporting');
    expect(out).toContain('Add folder…');
    expect(out).toContain('aria-label="Revoke access to nekko-agent"');
    expect(out).toContain('Revoke saved folder access, not delete files');
    // No star toggle unless the host wires one.
    expect(out).not.toContain('aria-pressed');
  });

  it('lists a sandbox chat\'s sandbox repositories, removable before the sandbox is set up (#2561)', () => {
    const repos = [{ provider: 'github' as const, fullName: 'acme/billing', cloneUrl: '', webUrl: '' }];
    const menu = (onRemoveSandboxRepo?: () => void) => renderToStaticMarkup(<FolderPickerMenu folders={folders} chat={{ workspaceId: 'a' }} onPick={() => {}} onClear={() => {}} onAdd={() => {}} onRemove={() => {}}
      onAddRepo={() => {}} reposConnected sandboxRepos={repos} onRemoveSandboxRepo={onRemoveSandboxRepo} />);
    const out = menu(() => {});
    expect(out).toContain('acme/billing');
    expect(out).toContain('In the sandbox');
    expect(out).toContain('aria-label="Remove acme/billing from this chat"');
    // Once the sandbox is made its repositories are fixed.
    expect(menu()).not.toContain('Remove acme/billing');
  });

  it('offers per-chat removal only for included folders, separately from saved-access revocation', () => {
    const out = renderToStaticMarkup(<FolderPickerMenu folders={folders} chat={{ workspaceId: 'a' }} onPick={() => {}} onClear={() => {}} onAdd={() => {}} onRemove={() => {}} onExclude={() => {}} />);
    expect(out).toContain('aria-label="Remove nekko-agent from this chat"');
    expect(out).not.toContain('aria-label="Remove hypergate from this chat"');
    expect(out).toContain('aria-label="Revoke access to nekko-agent"');
  });

  it('stars the default folders new chats start with', () => {
    const out = renderToStaticMarkup(<FolderPickerMenu folders={folders} chat={null} defaults={['b']} onPick={() => {}} onClear={() => {}} onAdd={() => {}} onRemove={() => {}} onToggleDefault={() => {}} />);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Stop starting new chats in hypergate"');
    expect(out).toContain('aria-label="Start new chats in nekko-agent"');
  });
});

describe('environment menu (#2404)', () => {
  const repo = { id: 'r', name: 'app', path: '/home/me/nekko-repos/me/app', addedAt: 0, repo: { provider: 'github' as const, fullName: 'me/app' } };
  const menu = (extra: Partial<React.ComponentProps<typeof FolderPickerMenu>>) => renderToStaticMarkup(
    <FolderPickerMenu folders={[...folders, repo]} chat={{ workspaceId: 'r' }} onPick={() => {}} onClear={() => {}} onAdd={() => {}} onRemove={() => {}} onExclude={() => {}} {...extra} />);

  it('splits local folders from repositories and offers to add a repository when a provider is connected', () => {
    const out = menu({ reposConnected: true, onAddRepo: () => {}, onConnectRepos: () => {} });
    expect(out.indexOf('>Folders<')).toBeLessThan(out.indexOf('>nekko-agent<'));
    expect(out.indexOf('>Repositories<')).toBeGreaterThan(out.indexOf('Add folder…'));
    expect(out.indexOf('>me/app<')).toBeGreaterThan(out.indexOf('>Repositories<'));
    expect(out).toContain('Add repository…');
    expect(out).not.toContain('Connect repositories');
    // A repository can be removed from the chat like any folder.
    expect(out).toContain('aria-label="Remove app from this chat"');
  });

  it('offers to connect repositories when no git provider is connected', () => {
    const out = menu({ reposConnected: false, onAddRepo: () => {}, onConnectRepos: () => {} });
    expect(out).toContain('Connect repositories');
    expect(out).not.toContain('Add repository…');
  });

  it('keeps the plain folder list when the host offers no repositories', () => {
    const out = menu({});
    expect(out).not.toContain('>Repositories<');
    expect(out).not.toContain('>Folders<');
    expect(out).toContain('>me/app<');
  });
});

describe('nextDefaultFolders', () => {
  it('stars by appending, unstars by removing, and drops folders that are gone', async () => {
    const { nextDefaultFolders } = await import('../defaultFolders.js');
    expect(nextDefaultFolders(undefined, 'a', folders)).toEqual(['a']);
    expect(nextDefaultFolders(['a'], 'b', folders)).toEqual(['a', 'b']);
    expect(nextDefaultFolders(['a', 'b'], 'a', folders)).toEqual(['b']);
    expect(nextDefaultFolders(['gone', 'a', 'a'], 'b', folders)).toEqual(['a', 'b']);
  });
});
