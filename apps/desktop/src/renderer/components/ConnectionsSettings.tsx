import { useEffect, useState } from 'react';
import { CONNECTION_GROUPS, CONNECTIONS, connectionAllowed, withConnection } from '@nekko-agent/shared';
import type { AppSettings, ConnectionEvent, ConnectionInfo, ConnectionStatus, ConnectionsStatus } from '@nekko-agent/shared';
import { GlobeIcon } from '../icons.js';
import { Toggle } from './primitives/Toggle.js';

/** How often the counts refresh while Settings is open. */
const POLL_MS = 5000;

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** "3 min ago · 42 in 24 h · 2 failed", or why there is nothing yet. */
export function statusLine(st: ConnectionStatus | undefined, now: number): string {
  if (!st?.lastAt) return 'No contact yet';
  const parts = [`Last ${ago(st.lastAt, now)}`, `${st.count24h} in 24 h`];
  if (st.errors24h) parts.push(`${st.errors24h} failed`);
  if (st.blocked24h) parts.push(`${st.blocked24h} blocked`);
  return parts.join(' · ');
}

function eventText(e: ConnectionEvent): string {
  const where = [e.method, e.host ? `${e.host}${e.path ?? ''}` : e.path].filter(Boolean).join(' ');
  const outcome = e.kind === 'blocked' ? 'blocked' : e.error ? e.error : e.status != null ? String(e.status) : e.kind;
  const extra = [e.ms != null ? `${e.ms} ms` : '', e.bytes != null ? `${e.bytes} B` : ''].filter(Boolean).join(' · ');
  return [where, outcome, extra].filter(Boolean).join('  ');
}

function EventLog({ id }: { id: string }) {
  const [events, setEvents] = useState<ConnectionEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => window.nekko.connectionsEvents(id, 200).then((e) => live && setEvents(e), () => live && setFailed(true));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  if (failed) return <p className="mt-2 text-[12px] text-danger" role="status">Couldn’t read the log.</p>;
  if (!events) return <p className="mt-2 text-[12px] text-ink-faint">Loading…</p>;
  if (!events.length) return <p className="mt-2 text-[12px] text-ink-faint">Nothing logged yet.</p>;
  return (
    <ol className="mt-2 max-h-56 overflow-auto rounded-md border border-line p-2 font-mono text-[11px]" aria-label="Connection log">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className={`flex gap-3 py-0.5 ${e.kind === 'blocked' || e.error || (e.status ?? 0) >= 400 ? 'text-danger' : ''}`}>
          <time className="shrink-0 text-ink-faint" dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString()}</time>
          <span className="min-w-0 break-all">{eventText(e)}</span>
        </li>
      ))}
    </ol>
  );
}

function Row({ c, st, on, disabled, onChange, now }: {
  c: ConnectionInfo;
  st: ConnectionStatus | undefined;
  on: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line py-3" data-connection={c.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px]">{c.label}</span>
          <span className="ml-2 text-[11px] text-ink-faint">{c.where}</span>
          <p className="text-[11px] text-ink-faint">{c.desc}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {statusLine(st, now)}
            <button className="ml-2 underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide log' : 'Show log'}</button>
          </p>
        </div>
        <Toggle label={c.label} value={on} disabled={disabled} onChange={onChange} />
      </div>
      {open && <EventLog id={c.id} />}
    </div>
  );
}

/**
 * Settings > Connections (#1034): All connections off, a switch per
 * connection, and each one's recent activity. The engine enforces both
 * switches (crates/nekko-net); this only saves `settings.connections`.
 */
export function ConnectionsSettings({ settings, update }: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const conn = settings.connections;
  const allOff = conn?.allOff === true;

  useEffect(() => {
    let live = true;
    const load = () => window.nekko.connectionsStatus().then((s) => { if (live) { setStatus(s); setNow(Date.now()); } }, () => {});
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  const byId = new Map((status?.connections ?? []).map((s) => [s.id, s]));
  const clear = async () => setStatus(await window.nekko.connectionsClear());

  return (
    <section className="card mt-5 p-5" id="connections">
      <div className="flex items-center gap-2"><GlobeIcon className="h-4 w-4" /><h2 className="font-semibold">Connections</h2></div>
      <p className="mt-1 text-[12px] text-ink-faint">
        Everything Nekko Agent connects to besides this computer. Nekko Agent sends no usage or crash reports unless you turn them on under System. The log keeps when each connection was used and where it went, never what was sent.
      </p>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3 rounded-md p-3" style={{ background: allOff ? 'color-mix(in srgb, var(--warning) 12%, transparent)' : 'var(--surface-2, transparent)' }}>
        <div className="min-w-0">
          <span className="text-[13px] font-medium">All connections off</span>
          <p className="text-[11px] text-ink-faint">
            Nothing reaches or leaves this computer over the network. Every chat runs Offline, so only local models on this computer answer.
          </p>
        </div>
        <Toggle label="All connections off" value={allOff} onChange={(v) => update({ connections: { ...conn, allOff: v } })} />
      </div>
      {CONNECTION_GROUPS.map((g) => (
        <div key={g.id} className="mt-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">{g.label}</h3>
          <p className="text-[11px] text-ink-faint">{g.desc}</p>
          {CONNECTIONS.filter((c) => c.group === g.id).map((c) => (
            <Row
              key={c.id}
              c={c}
              st={byId.get(c.id)}
              on={connectionAllowed(conn, c.id)}
              disabled={allOff}
              now={now}
              onChange={(v) => update({ connections: withConnection(conn, c.id, v) })}
            />
          ))}
        </div>
      ))}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <button className="btn btn-outline py-1.5 text-[12px]" onClick={() => void clear()}>Clear connection logs</button>
        <span className="text-[11px] text-ink-faint">Kept in logs/connections.log, at most about 6 MB.</span>
      </div>
    </section>
  );
}
