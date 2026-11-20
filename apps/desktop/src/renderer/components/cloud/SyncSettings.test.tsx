import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CloudStatus } from '@nekko-agent/shared';
import { SyncKinds } from './SyncSettings.js';
import { Toggle } from '../primitives/Toggle.js';

const status = (sync: Partial<CloudStatus['sync']> = {}, libraryCloud = true): CloudStatus => ({
  signedIn: true, oauthPending: false, keysStoredIn: 'Windows Credential Manager',
  account: { email: 'you@example.com', plan: 'pro', canSync: true, features: { libraryCloud } },
  sync: {
    phase: 'idle', enabled: true, recoveryConfirmed: true, keyEpoch: 1, lastSyncAt: null, error: null, progress: null,
    chats: 3, pushed: 0, pulled: 0, skipped: {}, fingerprint: null, joinCode: null, devices: [], usage: null,
    kinds: { chats: true, library: true },
    ...sync,
  },
} as CloudStatus);

const html = (s: CloudStatus) => renderToStaticMarkup(<SyncKinds status={s} busy={false} act={async () => {}} />);

/** The rows' switches, from the element tree (SettingRow holds each in `control`). */
function toggles(s: CloudStatus, act: (label: string, work: () => Promise<unknown>) => Promise<void>) {
  const tree = SyncKinds({ status: s, busy: false, act }) as React.ReactElement<{ children: React.ReactNode }>;
  const found: React.ReactElement<React.ComponentProps<typeof Toggle>>[] = [];
  React.Children.forEach(tree.props.children, (child) => {
    const control = React.isValidElement<{ control?: React.ReactNode }>(child) ? child.props.control : null;
    if (React.isValidElement<React.ComponentProps<typeof Toggle>>(control) && control.type === Toggle) found.push(control);
  });
  return found;
}

describe('Settings > Nekko Cloud > Sync: what syncs (#3089)', () => {
  it('lists Chats and Library with a switch each, both on by default', () => {
    const out = html(status());
    expect(out).toContain('What syncs');
    expect(out).toContain('data-sync-kind="chats"');
    expect(out).toContain('data-sync-kind="library"');
    expect(out).toContain('Every chat except incognito ones');
    expect(out.match(/aria-checked="true"/g)).toHaveLength(2);
  });

  it('shows Library only when the account has Library sync', () => {
    const out = html(status({}, false));
    expect(out).toContain('data-sync-kind="chats"');
    expect(out).not.toContain('data-sync-kind="library"');
  });

  it('says a kind that is off stays on this computer', () => {
    const out = html(status({ kinds: { chats: false, library: true } }));
    expect(out).toContain('Chats stay on this computer. Turn this back on to catch up.');
    expect(out).not.toContain('Every chat except incognito ones');
  });

  it('greys both rows and says why while Sync this computer is off', () => {
    const s = status({ enabled: false, phase: 'paused' });
    expect(html(s).match(/Paused while Sync this computer is off\./g)).toHaveLength(2);
    expect(toggles(s, async () => {}).every((t) => t.props.disabled)).toBe(true);
  });

  it('treats an engine without kinds as everything on', () => {
    const out = html(status({ kinds: undefined }));
    expect(out.match(/aria-checked="true"/g)).toHaveLength(2);
  });

  it('a switch turns its kind on or off through the engine', async () => {
    const syncSetKind = vi.fn(async () => status());
    vi.stubGlobal('window', { nekko: { syncSetKind } });
    const act = vi.fn(async (_label: string, work: () => Promise<unknown>) => { await work(); });
    const [chats, library] = toggles(status(), act);
    expect(chats.props.label).toBe('Sync Chats');
    chats.props.onChange(false);
    library.props.onChange(true);
    await Promise.resolve();
    expect(act.mock.calls.map((c) => c[0])).toEqual(['kind-chats', 'kind-library']);
    expect(syncSetKind.mock.calls).toEqual([['chats', false], ['library', true]]);
    vi.unstubAllGlobals();
  });
});
