import React from 'react';
import { createRoot } from 'react-dom/client';
import type { CloudStatus, FleetComputerView, OrgDetail } from '@nekko-agent/shared';
import { OrganizationSettings } from '../apps/desktop/src/renderer/components/cloud/OrganizationSettings';
import '../apps/desktop/src/renderer/styles.css';

// The real Organization section against a stub bridge. The state comes from the URL query (?s=):
// #locked, #setup, #plan, #invite, #empty, #full, #missing-key, #unavailable, and as the laptop sees them
// (decision 0102) #fleet and #fleet-refused.
const state = new URLSearchParams(location.search).get('s') || 'full';
const now = Date.now();
const calls: unknown[][] = [];
(window as unknown as { __calls: unknown[][] }).__calls = calls;

const phase = ({ locked: 'needs-join', setup: 'off', plan: 'needs-plan' } as Record<string, CloudStatus['sync']['phase']>)[state] ?? 'idle';
const status = {
  signedIn: true, oauthPending: false, keysStoredIn: 'Windows Credential Manager',
  account: { email: 'philip@nekkolabs.com', plan: 'pro', canSync: true },
  sync: { phase, devices: [] },
} as unknown as CloudStatus;

const model = (label: string, i: number) => ({ id: `m${i}`, label, runtime: 'llama.cpp' });
const computers: FleetComputerView[] = [
  { deviceId: 'd1', name: 'Philip-PC', os: 'windows', arch: 'x86_64', appVersion: '0.9.8', online: true, seenAt: now - 8_000, you: true, verified: true,
    models: [model('Qwen 3 Coder 30B', 1), model('Llama 3.1 8B', 2), model('Gemma 3 12B', 3), model('Mistral Small 24B', 4), model('Phi 4 14B', 5)] },
  { deviceId: 'd2', name: 'Philip MacBook Pro', os: 'macos', arch: 'aarch64', appVersion: '0.9.8', online: false, seenAt: now - 5 * 60_000, you: false, verified: true, models: [model('Llama 3.1 8B', 6)] },
  { deviceId: 'd3', name: 'Studio Linux box', os: 'linux', arch: 'x86_64', appVersion: '0.9.7', online: true, seenAt: now - 20_000, you: false, verified: false, models: [] },
];

// The laptop's view: this MacBook, the desk PC it can open, a box with remote access off, a teammate's PC, one offline.
const fleetComputers: FleetComputerView[] = [
  { deviceId: 'f1', name: 'Philip MacBook Pro', os: 'macos', arch: 'aarch64', appVersion: '0.9.8', online: true, seenAt: now - 4_000, you: true, verified: true, reach: 'you', models: [model('Llama 3.1 8B', 6)],
    runners: [{ label: 'nekko-cloud-mac', state: 'running', busy: 1, slots: 2 }] },
  { deviceId: 'f2', name: 'gomi', os: 'windows', arch: 'x86_64', appVersion: '0.9.8', online: true, seenAt: now - 8_000, you: false, verified: true, reach: 'ready',
    models: [model('Qwen 3 Coder 30B', 1), model('Gemma 3 27B', 2), model('Llama 3.3 70B', 3)] },
  { deviceId: 'f3', name: 'Studio Linux box', os: 'linux', arch: 'x86_64', appVersion: '0.9.8', online: true, seenAt: now - 20_000, you: false, verified: true, reach: 'no-remote', models: [model('Phi 4 14B', 5)] },
  { deviceId: 'f4', name: 'Sam-PC', os: 'windows', arch: 'x86_64', appVersion: '0.9.8', online: true, seenAt: now - 12_000, you: false, verified: false, reach: 'other-account', ownerEmail: 'sam@nekkolabs.com', models: [] },
  { deviceId: 'f5', name: 'Old laptop', os: 'macos', arch: 'aarch64', appVersion: '0.9.6', online: false, seenAt: now - 3 * 3600_000, you: false, verified: true, reach: 'no-remote', models: [],
    runners: [{ label: 'nekko-cloud-mac', state: 'ready', busy: 0, slots: 1 }] },
];
const fleetState = state === 'fleet' || state === 'fleet-refused';

const org: OrgDetail = {
  id: 'org1', name: 'Nekko Labs', role: 'owner', keyId: 1, memberCount: 3, createdAt: '2026-11-01T00:00:00Z', hasKey: state !== 'missing-key', sharing: state === 'full' || fleetState,
  members: [
    { userId: 'u1', email: 'philip@nekkolabs.com', role: 'owner', addedAt: '2026-11-01T00:00:00Z', you: true },
    { userId: 'u2', email: 'sam@nekkolabs.com', role: 'admin', addedAt: '2026-11-03T00:00:00Z', you: false },
    { userId: 'u3', email: 'ari@example.com', role: 'member', addedAt: '2026-11-05T00:00:00Z', you: false },
  ],
  invites: [{ id: 'iv1', email: 'jo@example.com', role: 'member', createdAt: '2026-11-10T00:00:00Z', expiresAt: '2026-11-24T00:00:00Z' }],
};
const hasOrg = ['empty', 'full', 'missing-key', 'fleet', 'fleet-refused'].includes(state);
const invites = state === 'invite' ? [{ id: 'i1', orgId: 'org9', orgName: 'Acme Robotics', role: 'member', invitedBy: 'maya@acme.example', expiresAt: '2026-11-24T00:00:00Z' }] : [];

const api: Record<string, (...a: any[]) => unknown> = {
  cloudStatus: () => Promise.resolve(status),
  cloudRefresh: () => Promise.resolve(status),
  orgList: () => (state === 'unavailable' ? Promise.reject(new Error('unknown channel: org:list')) : Promise.resolve({ orgs: hasOrg ? [org] : [], invites })),
  orgGet: () => Promise.resolve(org),
  fleetList: () => Promise.resolve({ orgId: 'org1', orgKeyId: 1, computers: state === 'empty' ? [] : fleetState ? fleetComputers : computers }),
  connectFleetComputer: (orgId: string, deviceId: string) => {
    calls.push(['computers:connectFleet', orgId, deviceId]);
    if (state === 'fleet-refused') return new Promise((_r, reject) => setTimeout(() => reject(new Error('gomi stopped sharing with this organization.')), 300));
    return new Promise((r) => setTimeout(() => r({ id: 'f7e1f0a9c2b3', name: 'gomi', relayUrl: 'ws://gomi.tailfd6474.ts.net:4400', alts: [], pairedAt: now, color: 0, fleet: orgId, state: 'online', route: null, read: true, change: true }), 300));
  },
  createSessionOn: (computerId: string) => {
    calls.push(['computers:createSession', computerId]);
    return Promise.resolve({ id: `computer:${computerId}:s1`, title: 'New chat', createdAt: now, updatedAt: now, messages: [], workspaceId: null });
  },
  listSessionSummaries: () => Promise.resolve([]),
  fleetSetSharing: (orgId: string, on: boolean) => { calls.push(['fleet:setSharing', orgId, on]); org.sharing = on; return Promise.resolve({ orgId, sharing: on, state: on ? 'online' : 'off' }); },
};
Object.assign(window, {
  nekko: new Proxy({}, {
    get: (_t, k: string) => api[k] ?? (k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)),
  }),
});

createRoot(document.getElementById('root')!).render(
  <main className="bg-paper" style={{ minHeight: '100vh', padding: 24 }}>
    <div className="mx-auto" style={{ maxWidth: 720 }}><OrganizationSettings /></div>
  </main>,
);
