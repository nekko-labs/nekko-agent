import React from 'react';
import { createRoot } from 'react-dom/client';
import type { CloudStatus, FleetComputerView, OrgDetail } from '@nekko-agent/shared';
import { OrganizationSettings } from '../apps/desktop/src/renderer/components/cloud/OrganizationSettings';
import '../apps/desktop/src/renderer/styles.css';

// The real Organization section against a stub bridge. The state comes from the URL query (?s=):
// #locked, #setup, #plan, #invite, #empty, #full, #missing-key, #unavailable.
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

const org: OrgDetail = {
  id: 'org1', name: 'Nekko Labs', role: 'owner', keyId: 1, memberCount: 3, createdAt: '2026-11-01T00:00:00Z', hasKey: state !== 'missing-key', sharing: state === 'full',
  members: [
    { userId: 'u1', email: 'philip@nekkolabs.com', role: 'owner', addedAt: '2026-11-01T00:00:00Z', you: true },
    { userId: 'u2', email: 'sam@nekkolabs.com', role: 'admin', addedAt: '2026-11-03T00:00:00Z', you: false },
    { userId: 'u3', email: 'ari@example.com', role: 'member', addedAt: '2026-11-05T00:00:00Z', you: false },
  ],
  invites: [{ id: 'iv1', email: 'jo@example.com', role: 'member', createdAt: '2026-11-10T00:00:00Z', expiresAt: '2026-11-24T00:00:00Z' }],
};
const hasOrg = ['empty', 'full', 'missing-key'].includes(state);
const invites = state === 'invite' ? [{ id: 'i1', orgId: 'org9', orgName: 'Acme Robotics', role: 'member', invitedBy: 'maya@acme.example', expiresAt: '2026-11-24T00:00:00Z' }] : [];

const api: Record<string, (...a: any[]) => unknown> = {
  cloudStatus: () => Promise.resolve(status),
  cloudRefresh: () => Promise.resolve(status),
  orgList: () => (state === 'unavailable' ? Promise.reject(new Error('unknown channel: org:list')) : Promise.resolve({ orgs: hasOrg ? [org] : [], invites })),
  orgGet: () => Promise.resolve(org),
  fleetList: () => Promise.resolve({ orgId: 'org1', orgKeyId: 1, computers: state === 'empty' ? [] : computers }),
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
