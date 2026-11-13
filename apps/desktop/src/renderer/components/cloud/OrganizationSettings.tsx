import { useCallback, useEffect, useRef, useState } from 'react';
import type { CloudStatus, FleetComputerView, FleetList, OrgDetail, OrgMember, OrgSummary, PendingOrgInvite } from '@nekko-agent/shared';
import { ComputerIcon, LaptopIcon, TerminalIcon } from '../../icons.js';
import { SettingRow, SettingsSection } from '../SettingsSection.js';
import { StatusDot } from '../primitives/index.js';
import { Toggle } from '../primitives/Toggle.js';
import {
  FLEET_POLL_MS, canManage, loadFleet, loadOrgs, lastSeen, orgErrorText, orgGate, osLabel, roleLabel, roleSentence,
  setSharing, sortComputers, splitModels, validEmail, type OrgGate, type OrgSnapshot,
} from './orgModel.js';
import './cloud.css';

/** Cloud status events can arrive every second while syncing; the lists need no more than this. */
const EVENT_REFRESH_MS = 3000;

export interface OrgHandlers {
  onSelect(orgId: string): void;
  onCreate(name: string): void;
  onAccept(inviteId: string): void;
  onInvite(email: string, role: 'admin' | 'member'): void;
  onRevokeInvite(inviteId: string): void;
  onRemoveMember(member: OrgMember): void;
  onSetSharing(on: boolean): void;
  onGoToSync(): void;
  /** Absent while plans and billing are switched off (#2724). */
  onSeePlans?: () => void;
}

export interface OrgViewProps extends OrgHandlers {
  gate: OrgGate;
  /** Nothing loaded yet. */
  loading: boolean;
  orgs: OrgSummary[];
  invites: PendingOrgInvite[];
  detail: OrgDetail | null;
  fleet: FleetList | null;
  /** Why the last call failed, in plain words. */
  error: string;
  /** The lists could not be loaded at all (an older engine, or offline). */
  unavailable?: boolean;
  fleetError: string;
  busy: string;
  /** For "Last seen" wording; tests pin it. */
  now?: number;
}

/** Settings > Phone pairing > Organization: share this computer with a team and see the team's computers. */
export function OrganizationView(p: OrgViewProps) {
  // Signed out: nothing new. Sign in under Sync first.
  if (p.gate === 'signed-out') return null;
  const org = p.detail;
  return (
    <SettingsSection id="organization" title="Organization" aria-label="Organization" data-testid="org-settings"
      help="Share your computers with a team. Your chats are never shared.">
      {p.gate === 'needs-plan' && (
        <div className="sync-row mt-(--q-inline)" data-testid="org-needs-plan">
          <p className="text-sm text-ink-soft">Organizations are part of Nekko Cloud Pro and Team.</p>
          {p.onSeePlans && <button className="btn btn-ghost shrink-0 py-1! text-xs!" onClick={p.onSeePlans}>See plans</button>}
        </div>
      )}
      {p.gate === 'needs-setup' && (
        <div className="sync-row mt-(--q-inline)" data-testid="org-needs-setup">
          <p className="text-sm text-ink-soft">Turn on sync first. Organizations use the same encryption key as your synced chats.</p>
          <button className="btn btn-ghost shrink-0 py-1! text-xs!" onClick={p.onGoToSync}>Go to Sync</button>
        </div>
      )}
      {p.gate === 'locked' && (
        <div className="sync-row mt-(--q-inline)" data-testid="org-locked">
          <p className="text-sm text-ink-soft">Unlock your account on this computer to use organizations. Use your recovery key, or approve this computer from another device, in Sync.</p>
          <button className="btn btn-ghost shrink-0 py-1! text-xs!" onClick={p.onGoToSync}>Go to Sync</button>
        </div>
      )}
      {p.gate === 'ready' && <Ready {...p} org={org} />}
      {p.error && <p role={p.unavailable ? 'status' : 'alert'} className={`mt-(--q-inline) text-xs ${p.unavailable ? 'text-ink-soft' : 'text-danger-text'}`} data-testid="org-error">{p.error}</p>}
    </SettingsSection>
  );
}

function Ready(p: OrgViewProps & { org: OrgDetail | null }) {
  const { org } = p;
  if (p.loading) return <p className="mt-(--q-inline) text-sm text-ink-faint" data-testid="org-loading">Loading…</p>;
  const hasOrgs = p.orgs.length > 0;
  return (
    <>
      {p.invites.length > 0 && <Invites invites={p.invites} busy={p.busy} onAccept={p.onAccept} primary={!hasOrgs} />}
      {!hasOrgs && !p.unavailable && <CreateOrg busy={p.busy === 'create'} onCreate={p.onCreate} />}
      {hasOrgs && p.orgs.length > 1 && (
        <div className="mt-(--q-group) flex flex-wrap gap-1" role="tablist" aria-label="Your organizations">
          {p.orgs.map((o) => (
            <button key={o.id} type="button" role="tab" aria-selected={o.id === org?.id} className="quiet-tab" onClick={() => p.onSelect(o.id)}>{o.name}</button>
          ))}
        </div>
      )}
      {org && <OrgBody {...p} org={org} />}
    </>
  );
}

function Invites({ invites, busy, onAccept, primary }: { invites: PendingOrgInvite[]; busy: string; onAccept: (id: string) => void; primary: boolean }) {
  return (
    <div className="mt-(--q-group)" data-testid="org-invites">
      <div className="quiet-group-label mb-(--q-heading)">Invitations</div>
      <ul>
        {invites.map((i) => (
          <li key={i.id} className="flex min-h-(--q-row) items-center justify-between gap-4 py-(--q-inline)">
            <div className="min-w-0 text-sm">
              <div className="truncate font-medium text-ink">Join {i.orgName}</div>
              <div className="mt-(--q-tight) truncate text-xs text-ink-faint">{i.invitedBy} invited you as {i.role === 'admin' ? 'an admin' : 'a member'}</div>
            </div>
            <button className={`btn ${primary ? 'btn-primary' : 'btn-ghost'} shrink-0 py-1! text-xs!`} disabled={!!busy} onClick={() => onAccept(i.id)} data-testid="org-accept">
              {busy === `accept:${i.id}` ? 'Joining…' : 'Accept'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateOrg({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  const ok = name.trim().length > 0;
  return (
    <form className="mt-(--q-group)" data-testid="org-create" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onCreate(name.trim()); }}>
      <div className="text-sm font-medium text-ink">Create an organization</div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">A team, a family or a company. You invite people by email, and everyone can see which computers are shared.</p>
      <div className="mt-(--q-inline) flex items-center gap-2">
        <input className="quiet-field min-w-0 flex-1 py-1.5" value={name} maxLength={80} placeholder="Organization name" aria-label="Organization name"
          onChange={(e) => setName(e.target.value)} data-testid="org-create-name" />
        <button type="submit" className="btn btn-primary shrink-0 py-1! text-xs!" disabled={!ok || busy} data-testid="org-create-submit">{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </form>
  );
}

function OrgBody(p: OrgViewProps & { org: OrgDetail }) {
  const { org } = p;
  const manager = canManage(org.role);
  return (
    <div data-testid="org-body" data-org-id={org.id}>
      <div className="mt-(--q-group) flex min-w-0 items-baseline gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-ink" data-testid="org-name">{org.name}</h3>
        <span className="shrink-0 text-xs text-ink-faint" data-testid="org-role">You are {roleSentence(org.role)}</span>
      </div>

      {org.hasKey ? (
        <SettingRow title={`Share this computer with ${org.name}`}
          detail={`Lists this computer and its local models for members of ${org.name}. Your chats are not uploaded, and nobody can run anything on it yet.`}
          control={<Toggle label={`Share this computer with ${org.name}`} value={org.sharing} disabled={!!p.busy} onChange={p.onSetSharing} />}
          data-testid="org-share" />
      ) : null}

      <Computers {...p} />
      <Members {...p} manager={manager} />
    </div>
  );
}

function OsIcon({ os }: { os: string }) {
  const cls = 'h-4 w-4';
  const Glyph = os === 'macos' ? LaptopIcon : os === 'linux' ? TerminalIcon : ComputerIcon;
  return <span aria-hidden className="flex shrink-0 text-ink-soft" data-os={os} title={osLabel(os)}><Glyph className={cls} /></span>;
}

function Computers(p: OrgViewProps & { org: OrgDetail }) {
  const { org } = p;
  const list = sortComputers(p.fleet?.computers ?? []);
  return (
    <div className="mt-(--q-group)" data-testid="org-computers">
      <div className="quiet-group-label mb-(--q-heading)">Computers</div>
      {!org.hasKey ? (
        <p className="text-sm text-ink-soft" data-testid="org-missing-key">{`This device does not have ${org.name}'s key yet. Ask an owner or admin to share it.`}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-soft" data-testid="org-empty">No computers shared with {org.name} yet.</p>
      ) : (
        <ul>{list.map((c) => <ComputerRow key={c.deviceId} c={c} now={p.now} />)}</ul>
      )}
      {p.fleetError && <p role="alert" className="mt-(--q-inline) text-xs text-danger-text" data-testid="org-fleet-error">{p.fleetError}</p>}
    </div>
  );
}

function ComputerRow({ c, now }: { c: FleetComputerView; now?: number }) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = splitModels(c.models, open);
  return (
    <li className="flex min-h-(--q-row) items-start justify-between gap-4 py-(--q-inline)" data-testid="org-computer" data-online={c.online} data-you={c.you}
      title={c.ownerEmail ? `${c.name}, ${c.ownerEmail}` : undefined}>
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5"><OsIcon os={c.os} /></span>
        <div className="min-w-0 text-sm">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-ink">{c.name}</span>
            {c.you && <span className="shrink-0 text-xs text-ink-faint" data-testid="org-this-computer">This computer</span>}
          </div>
          <div className="mt-(--q-tight) text-xs text-ink-faint" data-testid="org-models">
            {c.models.length === 0 ? 'No local models' : shown.map((m) => m.label).join(', ')}
            {hidden > 0 && <> <button type="button" className="text-ink-soft underline-offset-2 hover:underline" onClick={() => setOpen(true)} data-testid="org-more-models">+{hidden} more</button></>}
            {open && c.models.length > 3 && <> <button type="button" className="text-ink-soft underline-offset-2 hover:underline" onClick={() => setOpen(false)}>Show less</button></>}
          </div>
        </div>
      </div>
      <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-xs ${c.online ? 'text-ink-soft' : 'text-ink-faint'}`} data-testid="org-presence">
        <StatusDot tone={c.online ? 'success' : 'neutral'} size={7} />
        {c.online ? 'Online' : lastSeen(c.seenAt, now)}
      </span>
    </li>
  );
}

function Members(p: OrgViewProps & { org: OrgDetail; manager: boolean }) {
  const { org, manager } = p;
  return (
    <div className="mt-(--q-group)" data-testid="org-members">
      <div className="quiet-group-label mb-(--q-heading)">Members</div>
      <ul>
        {org.members.map((m) => (
          <li key={m.userId} className="flex min-h-(--q-row) items-center justify-between gap-4 py-(--q-inline)" data-quiet-row>
            <div className="min-w-0 text-sm">
              <span className="truncate font-medium text-ink">{m.email}</span>
              {m.you && <span className="ml-2 text-xs text-ink-faint">You</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="w-16 text-right text-xs text-ink-faint">{roleLabel(m.role)}</span>
              <span className="flex w-20 justify-end">{((manager && !m.you && m.role !== 'owner') || (m.you && m.role !== 'owner')) && (
                <button className="btn btn-ghost quiet-row-action py-1! text-xs! text-danger-text!" disabled={!!p.busy} onClick={() => p.onRemoveMember(m)} data-testid="org-remove-member">
                  {m.you ? 'Leave' : 'Remove'}
                </button>
              )}</span>
            </div>
          </li>
        ))}
      </ul>
      {manager && org.invites.length > 0 && (
        <ul className="mt-(--q-inline)" data-testid="org-sent-invites">
          {org.invites.map((i) => (
            <li key={i.id} className="flex min-h-(--q-row) items-center justify-between gap-4 py-(--q-inline)" data-quiet-row>
              <div className="min-w-0 truncate text-sm text-ink-soft">{i.email}<span className="ml-2 text-xs text-ink-faint">Invited as {i.role}</span></div>
              <button className="btn btn-ghost quiet-row-action shrink-0 py-1! text-xs!" disabled={!!p.busy} onClick={() => p.onRevokeInvite(i.id)}>Cancel invite</button>
            </li>
          ))}
        </ul>
      )}
      {manager && <InviteForm busy={p.busy === 'invite'} onInvite={p.onInvite} />}
    </div>
  );
}

function InviteForm({ busy, onInvite }: { busy: boolean; onInvite: (email: string, role: 'admin' | 'member') => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const ok = validEmail(email);
  return (
    <form className="mt-(--q-group)" data-testid="org-invite-form" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) { onInvite(email.trim(), role); setEmail(''); } }}>
      <div className="flex items-center gap-2">
        <input className="quiet-field min-w-0 flex-1 py-1.5" type="email" value={email} placeholder="Invite by email" aria-label="Email to invite"
          onChange={(e) => setEmail(e.target.value)} data-testid="org-invite-email" />
        <select className="quiet-field w-auto py-1.5" value={role} aria-label="Role for the new member" onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="btn btn-ghost shrink-0 py-1! text-xs!" disabled={!ok || busy} data-testid="org-invite-submit">{busy ? 'Inviting…' : 'Invite'}</button>
      </div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">They see the invitation when they sign in to Nekko Cloud with that email.</p>
    </form>
  );
}

/** The section, wired to the engine: loads on mount, refreshes on cloud status events and polls the Computers list. */
export function OrganizationSettings() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [snap, setSnap] = useState<OrgSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [visible, setVisible] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const wanted = useRef<string | null>(null);
  const seq = useRef(0);
  const lastLoad = useRef(0);
  const gate = orgGate(status);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    lastLoad.current = Date.now();
    try {
      const next = await loadOrgs(window.nekko, wanted.current);
      if (mine !== seq.current) return;
      wanted.current = next.detail?.id ?? null;
      setSnap(next);
      setError('');
    } catch (e) {
      if (mine === seq.current) setError(orgErrorText(e));
    }
  }, []);

  // Cloud status: now, and whenever the engine says it changed (also how an org change elsewhere reaches us).
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    window.nekko.cloudStatus().then((s) => { if (live) setStatus(s); }).catch(() => {});
    const off = window.nekko.onCloudStatus((s) => {
      if (!live) return;
      setStatus(s);
      const wait = EVENT_REFRESH_MS - (Date.now() - lastLoad.current);
      if (wait <= 0) void reload();
      else if (!timer) timer = setTimeout(() => { timer = undefined; if (live) void reload(); }, wait);
    });
    return () => { live = false; off(); if (timer) clearTimeout(timer); };
  }, [reload]);

  useEffect(() => { if (gate === 'ready') void reload(); else setSnap(null); }, [gate, reload]);

  // Pause while the section is scrolled out of view.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [gate]);

  const orgId = snap?.detail?.id ?? null;
  const hasKey = snap?.detail?.hasKey ?? false;
  useEffect(() => {
    if (gate !== 'ready' || !orgId || !hasKey || !visible) return;
    const tick = async () => {
      if (document.visibilityState === 'hidden') return;
      const r = await loadFleet(window.nekko, { id: orgId, hasKey });
      setSnap((s) => (s?.detail?.id === orgId ? { ...s, fleet: r.fleet ?? s.fleet, fleetError: r.error } : s));
    };
    const id = setInterval(() => void tick(), FLEET_POLL_MS);
    return () => clearInterval(id);
  }, [gate, orgId, hasKey, visible]);

  const act = useCallback(async (label: string, work: () => Promise<unknown>) => {
    setError('');
    setBusy(label);
    try {
      await work();
      await reload();
    } catch (e) {
      setError(orgErrorText(e));
    } finally {
      setBusy('');
    }
  }, [reload]);

  const detail = snap?.detail ?? null;
  const handlers: OrgHandlers = {
    onSelect: (id) => { wanted.current = id; void reload(); },
    onCreate: (name) => void act('create', async () => { const o = await window.nekko.orgCreate(name); wanted.current = o?.id ?? null; }),
    onAccept: (id) => void act(`accept:${id}`, async () => { await window.nekko.orgAcceptInvite(id); }),
    onInvite: (email, role) => void act('invite', () => window.nekko.orgInvite(detail!.id, email, role)),
    onRevokeInvite: (id) => void act('revoke', () => window.nekko.orgRevokeInvite(detail!.id, id)),
    onRemoveMember: (m) => {
      const msg = m.you ? `Leave ${detail?.name}? Your computers stop being shared with it.` : `Remove ${m.email} from ${detail?.name}?`;
      if (window.confirm(msg)) void act('remove', () => window.nekko.orgRemoveMember(detail!.id, m.userId));
    },
    onSetSharing: (on) => void act('share', () => setSharing(window.nekko, detail!.id, on)),
    onGoToSync: () => document.getElementById('sync')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    // Upgrade lives under the account in Sync.
    onSeePlans: status?.account?.features?.billing ? () => document.getElementById('sync')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : undefined,
  };

  return (
    <div ref={root}>
      <OrganizationView {...handlers} gate={gate} loading={gate === 'ready' && !snap && !error}
        orgs={snap?.list.orgs ?? []} invites={snap?.list.invites ?? []} detail={detail} fleet={snap?.fleet ?? null}
        error={error} unavailable={!snap && !!error} fleetError={snap?.fleetError ?? ''} busy={busy} />
    </div>
  );
}
