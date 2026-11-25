import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CloudStatus, FleetComputerView, FleetList, OrgDetail, OrgSummary } from '@nekko-agent/shared';
import { OrganizationView, type OrgViewProps } from './OrganizationSettings.js';
import { Toggle } from '../primitives/Toggle.js';
import {
  FLEET_FAST_PATH, FLEET_POLL_CONNECTED_MS, FLEET_POLL_MS, canManage, canOpen, fleetPollMs, lastSeen, loadFleet, loadOrgs, openOnComputer, orgErrorText, orgGate, orgListErrorText, reachNote, relayPresenceKey, setSharing, sortComputers, splitModels,
  type FleetOpenApi, type OrgApi,
} from './orgModel.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const noop = () => {};

const org = (over: Partial<OrgDetail> = {}): OrgDetail => ({
  id: 'org1', name: 'Nekko Labs', role: 'owner', keyId: 1, memberCount: 2, createdAt: '2026-11-01T00:00:00Z', hasKey: true, sharing: false,
  members: [
    { userId: 'u1', email: 'philip@nekkolabs.com', role: 'owner', addedAt: '2026-11-01T00:00:00Z', you: true },
    { userId: 'u2', email: 'sam@example.com', role: 'member', addedAt: '2026-11-02T00:00:00Z', you: false },
  ],
  invites: [],
  ...over,
});

const computer = (over: Partial<FleetComputerView> = {}): FleetComputerView => ({
  deviceId: 'd1', name: 'Philip-PC', os: 'windows', arch: 'x86_64', appVersion: '0.9.8', models: [], online: true, seenAt: NOW - 5_000, you: false, verified: true, ...over,
});

const fleet = (computers: FleetComputerView[]): FleetList => ({ orgId: 'org1', orgKeyId: 1, computers });

function props(over: Partial<OrgViewProps> = {}): OrgViewProps {
  const detail = over.detail === undefined ? org() : over.detail;
  return {
    gate: 'ready', loading: false, orgs: detail ? [detail as OrgSummary] : [], invites: [], detail, fleet: null, error: '', fleetError: '', busy: '', now: NOW,
    onSelect: noop, onCreate: async () => {}, onRetry: noop, onAccept: noop, onInvite: noop, onRevokeInvite: noop, onRemoveMember: noop, onSetSharing: noop, onGoToSync: noop,
    ...over,
  };
}
const html = (p: OrgViewProps) => renderToStaticMarkup(<OrganizationView {...p} />);

/** Expands function components (skipping any that need hooks) and collects the elements `pick` accepts. */
function find(node: React.ReactNode, pick: (el: React.ReactElement<Record<string, any>>) => boolean, out: React.ReactElement<Record<string, any>>[] = []) {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    if (pick(child)) out.push(child);
    if (typeof child.type === 'function' && child.type !== Toggle) {
      try { find((child.type as (p: unknown) => React.ReactNode)(child.props), pick, out); } catch { /* a component with hooks */ }
    }
    find(child.props.children, pick, out);
  });
  return out;
}

describe('Organization section gating', () => {
  it('shows nothing when signed out', () => {
    expect(html(props({ gate: 'signed-out', detail: null }))).toBe('');
  });

  it('asks a locked computer to unlock, and points at Sync', () => {
    const out = html(props({ gate: 'locked', detail: null }));
    expect(out).toContain('Unlock your account on this computer to use organizations');
    expect(out).toContain('recovery key');
    expect(out).toContain('Go to Sync');
    expect(out).not.toContain('Create a fleet');
  });

  it('says what to do when sync was never turned on, and when the plan lacks it', () => {
    expect(html(props({ gate: 'needs-setup', detail: null }))).toContain('Turn on sync first');
    const plan = html(props({ gate: 'needs-plan', detail: null }));
    expect(plan).toContain('Pro and Enterprise');
    // Nothing to buy until plans and billing are switched on (#2724).
    expect(plan).not.toContain('See plans');
    expect(html(props({ gate: 'needs-plan', detail: null, onSeePlans: noop }))).toContain('See plans');
  });

  it('derives the gate from the cloud status', () => {
    const status = (signedIn: boolean, phase: CloudStatus['sync']['phase']) => ({ signedIn, sync: { phase } }) as CloudStatus;
    expect(orgGate(null)).toBe('signed-out');
    expect(orgGate(status(false, 'signed-out'))).toBe('signed-out');
    expect(orgGate(status(true, 'needs-plan'))).toBe('needs-plan');
    expect(orgGate(status(true, 'off'))).toBe('needs-setup');
    expect(orgGate(status(true, 'needs-join'))).toBe('locked');
    expect(orgGate(status(true, 'awaiting-approval'))).toBe('locked');
    for (const phase of ['idle', 'syncing', 'paused', 'error'] as const) expect(orgGate(status(true, phase))).toBe('ready');
  });
});

describe('No organization yet', () => {
  it('offers to create one', () => {
    const out = html(props({ detail: null }));
    expect(out).toContain('Create a fleet');
    expect(out).not.toContain('Fleet name');
    expect(out).not.toContain('Share this computer');
  });

  it('keeps Create a fleet available when a selected fleet cannot load or when a fleet already exists', () => {
    expect(html(props())).toContain('Create a fleet');
    expect(html(props({ detail: null, orgs: [org()], error: "That organization wasn't found." }))).toContain('Create a fleet');
  });

  it('distinguishes an unavailable cloud from an empty list', () => {
    const out = html(props({ detail: null, unavailable: true, error: orgListErrorText(new Error("That organization wasn't found.")) }));
    expect(out).toContain('Fleet management is not available on Nekko Cloud right now.');
    expect(out).toContain('Try again');
    expect(out).not.toContain('Create a fleet');
  });

  it('lists pending invites with Accept, and keeps the create form', () => {
    const out = html(props({ detail: null, invites: [{ id: 'i1', orgId: 'org9', orgName: 'Acme', role: 'member', invitedBy: 'boss@acme.com', expiresAt: '2026-11-20T00:00:00Z' }] }));
    expect(out).toContain('Join Acme');
    expect(out).toContain('boss@acme.com invited you as a member');
    expect(out).toContain('Accept');
    expect(out).toContain('Create a fleet');
  });

  it('wires Accept to the invite id', () => {
    const onAccept = vi.fn();
    const p = props({ detail: null, onAccept, invites: [{ id: 'i1', orgId: 'org9', orgName: 'Acme', role: 'admin', invitedBy: 'boss@acme.com', expiresAt: '' }] });
    const [button] = find(OrganizationView(p), (el) => el.type === 'button' && el.props['data-testid'] === 'org-accept');
    button.props.onClick();
    expect(onAccept).toHaveBeenCalledWith('i1');
  });

  it('fails softly when the engine does not know the channels yet', () => {
    const out = html(props({ detail: null, orgs: [], unavailable: true, error: orgErrorText(new Error('unknown channel: org:list')) }));
    expect(out).toContain('Organizations are not available in this version of Nekko Agent yet');
    expect(out).not.toContain('Create a fleet');
  });
});

describe('An organization', () => {
  it('shows the name, your role, members and the invite form for an owner', () => {
    const out = html(props());
    expect(out).toContain('Nekko Labs');
    expect(out).toContain('You are an owner');
    expect(out).toContain('philip@nekkolabs.com');
    expect(out).toContain('sam@example.com');
    expect(out).toContain('>You</span>');
    expect(out).toContain('Invite by email');
  });

  it('hides invites and removal from a plain member', () => {
    const out = html(props({ detail: org({ role: 'member', members: [
      { userId: 'u1', email: 'philip@nekkolabs.com', role: 'owner', addedAt: '', you: false },
      { userId: 'u2', email: 'sam@example.com', role: 'member', addedAt: '', you: true },
    ] }) }));
    expect(out).toContain('You are a member');
    expect(out).not.toContain('Invite by email');
    expect(out).not.toContain('>Remove<');
    expect(out).toContain('>Leave<');
  });

  it('lists invites an admin sent, with a way to cancel', () => {
    const out = html(props({ detail: org({ role: 'admin', invites: [{ id: 'iv', email: 'new@example.com', role: 'member', createdAt: '', expiresAt: '' }] }) }));
    expect(out).toContain('new@example.com');
    expect(out).toContain('Cancel invite');
    expect(canManage('admin')).toBe(true);
    expect(canManage('member')).toBe(false);
  });

  it('shows the sharing switch off by default, with its one-line explanation and no Connect or Run without a ready computer', () => {
    const out = html(props());
    expect(out).toContain('Share this computer with Nekko Labs');
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
    expect(out).toContain('Lists this computer and its local models for members of Nekko Labs. With Remote access on, your own other computers can open chats on it. Your chats are not uploaded.');
    expect(out).not.toMatch(/>(Connect|Run)</);
  });

  it('turns sharing on through fleet:setSharing', async () => {
    const onSetSharing = vi.fn();
    const [toggle] = find(OrganizationView(props({ onSetSharing })), (el) => el.type === Toggle);
    expect(toggle.props.value).toBe(false);
    toggle.props.onChange(true);
    expect(onSetSharing).toHaveBeenCalledWith(true);

    const api = { fleetSetSharing: vi.fn().mockResolvedValue({ orgId: 'org1', sharing: true, state: 'publishing' }) } as unknown as OrgApi;
    await expect(setSharing(api, 'org1', true)).resolves.toBe(true);
    expect(api.fleetSetSharing).toHaveBeenCalledWith('org1', true);
  });

  it('shows the switch on when this computer shares', () => {
    expect(html(props({ detail: org({ sharing: true }) }))).toMatch(/aria-checked="true"/);
  });

  it('offers a tab per organization when there are several', () => {
    const a = org();
    const b = org({ id: 'org2', name: 'Home' });
    const out = html(props({ orgs: [a, b], detail: a }));
    expect(out).toContain('role="tablist"');
    expect(out).toContain('>Home<');
  });
});

describe('Computers', () => {
  it('says so when none are shared', () => {
    expect(html(props({ fleet: fleet([]) }))).toContain('No computers shared with Nekko Labs yet.');
  });

  it('explains a missing org key, and hides the switch', () => {
    const out = html(props({ detail: org({ hasKey: false }) }));
    expect(out).toContain('This device does not have Nekko Labs&#x27;s key yet.');
    expect(out).not.toContain('Share this computer');
    expect(out).not.toContain('No computers shared');
  });

  it('shows an online computer with a dot and the word Online', () => {
    const out = html(props({ fleet: fleet([computer({ models: [{ id: 'm', label: 'Llama 3.1 8B', runtime: 'llama.cpp' }] })]) }));
    expect(out).toContain('Philip-PC');
    expect(out).toContain('data-os="windows"');
    expect(out).toContain('Online');
    expect(out).toContain('Llama 3.1 8B');
  });

  it('shows an offline computer with when it was last seen', () => {
    const out = html(props({ fleet: fleet([computer({ name: 'Laptop', os: 'macos', online: false, seenAt: NOW - 5 * 60_000 })]) }));
    expect(out).toContain('Last seen 5 min ago');
    expect(out).toContain('data-os="macos"');
    expect(out).toContain('No local models');
    expect(out).not.toContain('>Online<');
  });

  it('tags this computer and lists it first', () => {
    const out = html(props({ fleet: fleet([computer({ deviceId: 'a', name: 'Aardvark' }), computer({ deviceId: 'b', name: 'Zed', you: true })]) }));
    expect(out).toContain('This computer');
    expect(out.indexOf('Zed')).toBeLessThan(out.indexOf('Aardvark'));
    expect(sortComputers([{ you: false, online: false, name: 'b' }, { you: false, online: true, name: 'c' }, { you: true, online: false, name: 'a' }]).map((c) => c.name)).toEqual(['a', 'c', 'b']);
  });

  it('collapses local models after three', () => {
    const models = ['A', 'B', 'C', 'D', 'E'].map((x) => ({ id: x, label: `Model ${x}`, runtime: 'llama.cpp' }));
    const out = html(props({ fleet: fleet([computer({ models })]) }));
    expect(out).toContain('Model A, Model B, Model C');
    expect(out).not.toContain('Model D');
    expect(out).toContain('+2 more');
    expect(splitModels(models, true)).toEqual({ shown: models, hidden: 0 });
    expect(splitModels(models.slice(0, 3), false).hidden).toBe(0);
  });

  it('has no Connect or Run button on a computer', () => {
    const out = html(props({ fleet: fleet([computer()]) }));
    expect(out).not.toMatch(/>(Connect|Run|Open)</);
  });

  it('shows a Computers error without dropping the rest', () => {
    const out = html(props({ fleetError: 'Could not reach Nekko Cloud.' }));
    expect(out).toContain('Could not reach Nekko Cloud.');
    expect(out).toContain('Members');
  });
});

describe('Loading and errors', () => {
  it('formats last seen', () => {
    expect(lastSeen(NOW - 10_000, NOW)).toBe('Last seen just now');
    expect(lastSeen(NOW - 3 * 3600_000, NOW)).toBe('Last seen 3 h ago');
    expect(lastSeen(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('Last seen 2 d ago');
    expect(lastSeen(null, NOW)).toBe('Offline');
  });

  it('turns engine errors into plain text', () => {
    expect(orgErrorText(new Error('unknown channel: fleet:list'))).toMatch(/not available in this version/);
    expect(orgErrorText(new Error('plan-required'))).toMatch(/Pro or Enterprise/);
    expect(orgErrorText(new Error('orgs-not-available'))).toMatch(/not available for your account/);
    expect(orgErrorText(new Error('Could not reach Nekko Cloud'))).toBe('Could not reach Nekko Cloud');
  });

  it('loads the overview, the organization and its computers, and survives a failed computers call', async () => {
    const o = org();
    const api = {
      orgList: vi.fn().mockResolvedValue({ orgs: [o], invites: [] }),
      orgGet: vi.fn().mockResolvedValue(o),
      fleetList: vi.fn().mockResolvedValue(fleet([computer()])),
      fleetSetSharing: vi.fn(),
    } as unknown as OrgApi;
    const snap = await loadOrgs(api, null);
    expect(snap.detail?.id).toBe('org1');
    expect(snap.fleet?.computers).toHaveLength(1);

    (api.fleetList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unknown channel: fleet:list'));
    const soft = await loadOrgs(api, 'org1');
    expect(soft.detail?.id).toBe('org1');
    expect(soft.fleet).toBeNull();
    expect(soft.fleetError).toMatch(/not available in this version/);
  });

  it('preserves fleets and invitations when the selected fleet no longer loads', async () => {
    const list = { orgs: [org(), org({ id: 'missing' })], invites: [{ id: 'invite1' }] };
    const api = { orgList: vi.fn().mockResolvedValue(list), orgGet: vi.fn().mockRejectedValue(Error("That organization wasn't found.")), fleetList: vi.fn() } as unknown as OrgApi;
    expect(await loadOrgs(api, 'missing')).toMatchObject({ list, selectedId: 'missing', detail: null, detailError: "That organization wasn't found." });
    expect(api.fleetList).not.toHaveBeenCalled();
  });

  it('does not ask for computers while this device lacks the key', async () => {
    const api = { fleetList: vi.fn() } as unknown as OrgApi;
    await expect(loadFleet(api, { id: 'org1', hasKey: false })).resolves.toEqual({ fleet: null, error: '' });
    expect(api.fleetList).not.toHaveBeenCalled();
  });

  it('shows Loading before the first answer', () => {
    expect(html(props({ loading: true, detail: null }))).toContain('Loading');
  });

  it('never uses an em dash in its copy', () => {
    const out = html(props({ fleet: fleet([computer()]) })) + html(props({ gate: 'locked', detail: null })) + html(props({ detail: null }));
    expect(out).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('Opening a chat on a listed computer (decision 0102)', () => {
  const rows = (cs: FleetComputerView[], over: Partial<OrgViewProps> = {}) => html(props({ fleet: fleet(cs), onOpenChat: async () => {}, ...over }));

  it('offers Open chat only on your own online computers that are ready', () => {
    const out = rows([computer({ reach: 'ready' })]);
    expect(out).toContain('data-testid="org-open-chat"');
    expect(out).toContain('aria-label="Open a chat on Philip-PC"');
    expect(out).toContain('Open chat');
    for (const c of [
      computer({ reach: 'ready', online: false }),
      computer({ reach: 'you', you: true }),
      computer({ reach: 'other-account', ownerEmail: 'sam@example.com' }),
      computer({ reach: 'no-remote' }),
      computer({ reach: 'unverified' }),
      computer({ reach: 'locked' }),
      computer({ reach: undefined }),
    ]) {
      expect(rows([c]), c.reach).not.toContain('org-open-chat');
    }
    // No handler wired (an older window): nothing to press.
    expect(html(props({ fleet: fleet([computer({ reach: 'ready' })]) }))).not.toContain('org-open-chat');
  });

  it('says in one line why an online computer cannot be opened, and nothing otherwise', () => {
    expect(reachNote(computer({ reach: 'other-account', ownerEmail: 'sam@example.com' }))).toBe('Shared by sam@example.com. Only they can open chats on it.');
    expect(reachNote(computer({ reach: 'no-remote' }))).toBe('Turn on Remote access on Philip-PC to open chats on it from here.');
    expect(reachNote(computer({ reach: 'unverified' }))).toContain('Not verified');
    expect(reachNote(computer({ reach: 'locked' }))).toContain('Open Sync');
    // Offline already says so; this computer, a ready one and an older engine need nothing.
    expect(reachNote(computer({ reach: 'no-remote', online: false }))).toBeNull();
    expect(reachNote(computer({ reach: 'you', you: true }))).toBeNull();
    expect(reachNote(computer({ reach: 'ready' }))).toBeNull();
    expect(reachNote(computer({}))).toBeNull();
    const out = rows([computer({ reach: 'no-remote' })]);
    expect(out.match(/data-testid="org-reach-note"/g)).toHaveLength(1);
    expect(canOpen(computer({ reach: 'ready' }))).toBe(true);
    expect(canOpen(computer({ reach: 'ready', you: true }))).toBe(false);
  });

  it('connects with no code, then starts the chat on that computer', async () => {
    const calls: string[] = [];
    const api: FleetOpenApi = {
      connectFleetComputer: vi.fn(async (orgId: string, deviceId: string) => {
        calls.push(`connect ${orgId} ${deviceId}`);
        return { id: 'f7e1f0a9c2b3', name: 'Philip-PC', relayUrl: 'ws://gomi:4400', alts: [], pairedAt: 1, color: 0, fleet: orgId, state: 'online' as const, route: null, read: true, change: true };
      }),
      createSessionOn: vi.fn(async (computerId: string) => {
        calls.push(`session ${computerId}`);
        return { id: 'computer:f7e1f0a9c2b3:s1' } as Awaited<ReturnType<FleetOpenApi['createSessionOn']>>;
      }),
    };
    const s = await openOnComputer(api, 'org1', 'dev-1');
    expect(s.id).toBe('computer:f7e1f0a9c2b3:s1');
    expect(calls).toEqual(['connect org1 dev-1', 'session f7e1f0a9c2b3']);
    // A refusal stops before any chat is made, and carries its sentence.
    const refused: FleetOpenApi = { ...api, connectFleetComputer: vi.fn(async () => { throw new Error('Philip-PC stopped sharing with this organization.'); }) };
    calls.length = 0;
    await expect(openOnComputer(refused, 'org1', 'dev-1')).rejects.toThrow('stopped sharing');
    expect(calls).toEqual([]);
  });

  it('says on the share switch that your own computers can open chats here', () => {
    expect(html(props())).toContain('your own other computers can open chats on it');
  });
});

describe('the Computers list refresh pace', () => {
  it('stays at 15 seconds in this build: the slower poll is off until the API lease outlasts the engine beat', () => {
    expect(FLEET_FAST_PATH).toBe(false);
    expect(fleetPollMs(true)).toBe(FLEET_POLL_MS);
    expect(fleetPollMs(false)).toBe(FLEET_POLL_MS);
  });

  it('is a minute while the account channel is up, with the fast path on', () => {
    expect(fleetPollMs(true, true)).toBe(FLEET_POLL_CONNECTED_MS);
    expect(FLEET_POLL_CONNECTED_MS).toBe(60_000);
    expect(fleetPollMs(false, true)).toBe(FLEET_POLL_MS);
  });

  it('keys presence so a computer coming or going changes it, and no channel is empty', () => {
    const status = (relay: CloudStatus['relay']) => ({ relay } as CloudStatus);
    expect(relayPresenceKey(null)).toBe('');
    expect(relayPresenceKey(status(null))).toBe('');
    expect(relayPresenceKey(status({ connected: false, online: [] }))).toBe('');
    const alone = relayPresenceKey(status({ connected: true, online: [] }));
    const withPhone = relayPresenceKey(status({ connected: true, online: [{ dev: 'p1', kind: 'phone' }] }));
    const withBoth = relayPresenceKey(status({ connected: true, online: [{ dev: 'p2', kind: 'phone' }, { dev: 'p1', kind: 'computer' }] }));
    expect(new Set(['', alone, withPhone, withBoth]).size).toBe(4);
    expect(withBoth).toBe('p1,p2');
  });
});
