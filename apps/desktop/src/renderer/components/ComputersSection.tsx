import { useEffect, useState } from 'react';
import { COMPUTER_ICONS, parsePairingLink, pairingLink, relayRoute, type ComputerState, type ComputerStatus, type NekkoApi } from '@nekko-agent/shared';
import { COMPUTER_ICON_GLYPHS, ComputerIcon } from '../icons.js';
import { useStore } from '../store.js';
import { ComputerGlyph } from './ComputerChip.js';
import { pairingAlts } from './RemoteAccess.js';

const STATE_LABEL: Record<ComputerState, string> = {
  connecting: 'Connecting',
  online: 'Connected',
  offline: 'Offline',
  denied: 'Removed by that computer. Connect it again.',
  update: 'Needs an update',
};

const STATE_COLOR: Record<ComputerState, string> = {
  connecting: 'var(--warning)',
  online: 'var(--success)',
  offline: 'var(--ink-faint)',
  denied: 'var(--danger)',
  update: 'var(--warning)',
};

const ROUTE_LABEL: Record<string, string> = { lan: 'on this network', tailscale: 'over Tailscale', internet: 'over the relay', loopback: 'on this computer' };

/** A computer's line under its name: its state, how it is reached, and what it allows. */
export function computerDetail(c: ComputerStatus): string {
  const route = c.state === 'online' && c.route ? ` ${ROUTE_LABEL[relayRoute(c.route)] ?? ''}` : '';
  const watching = c.state === 'online' && !c.change ? `. ${c.name} allows watching only.` : '';
  return `${STATE_LABEL[c.state]}${route}${watching}`;
}

/** The link that lets another computer connect here, or why there can't be one yet. */
export async function computerLink(api: Pick<NekkoApi, 'getRemoteStatus' | 'getRemotePairing' | 'startComputerPairing' | 'localRelayStatus'>): Promise<{ link: string } | { note: string }> {
  const status = await api.getRemoteStatus();
  const pairing = status.enabled ? await api.getRemotePairing() : null;
  if (!pairing) return { note: 'Set up Phone pairing first: it chooses how other devices reach this computer.' };
  const grant = await api.startComputerPairing();
  const local = await api.localRelayStatus().catch(() => null);
  return { link: pairingLink('nekko-agent-pair:', { ...pairing, pair: grant.code, alts: pairingAlts(pairing.relayUrl, local) }) };
}

/** Pick a computer's icon. Shows only if one is set: there is no default. */
function IconPicker({ icon, label, onPick }: { icon?: string; label: string; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (next: string) => { setOpen(false); onPick(next); };
  return (
    <span className="relative shrink-0">
      <button className="btn btn-ghost h-7 w-7 p-0" aria-label={`Icon for ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon ? <ComputerGlyph icon={icon} className="h-4 w-4" /> : <span className="text-2xs text-ink-faint">Icon</span>}
      </button>
      {open && (
        <div role="menu" className="card absolute left-0 top-8 z-10 w-56 p-2" data-icon-picker>
          <div className="grid grid-cols-6 gap-1">
            {COMPUTER_ICONS.map((id) => {
              const Glyph = COMPUTER_ICON_GLYPHS[id];
              return <button key={id} role="menuitem" title={id} aria-label={id} className={`btn btn-ghost h-8 w-8 p-0 ${icon === id ? 'ring-1 ring-accent' : ''}`} onClick={() => pick(id)}><Glyph className="h-4 w-4" /></button>;
            })}
          </div>
          <button role="menuitem" className="btn btn-ghost mt-1 w-full py-0.5 text-xs" onClick={() => pick('')}>No icon</button>
        </div>
      )}
    </span>
  );
}

/** Settings > Computers: the computers this one reaches, and the link that lets another reach it. */
export function ComputersSection() {
  const [computers, setComputers] = useState<ComputerStatus[]>([]);
  const machineIcon = useStore((s) => s.settings?.machineIcon);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const [adding, setAdding] = useState(false);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [link, setLink] = useState('');
  const [linkNote, setLinkNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => void window.nekko.listComputers().then((list) => live && setComputers(list)).catch(() => {});
    load();
    const off = window.nekko.onComputersUpdated(load);
    return () => { live = false; off(); };
  }, []);

  const add = async () => {
    const parsed = parsePairingLink(paste);
    if (!parsed) return setError("That doesn't look like a pairing link.");
    setBusy(true);
    setError(null);
    try {
      await window.nekko.pairComputer(parsed);
      setPaste('');
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (c: ComputerStatus) => {
    if (!confirm(`Remove ${c.name}? Its agents leave this computer's list. They keep running there.`)) return;
    setComputers(await window.nekko.forgetComputer(c.id));
  };

  const setIcon = async (c: ComputerStatus, icon: string) => {
    try {
      setComputers(await window.nekko.setComputerIcon(c.id, icon));
    } catch (e) {
      useStore.getState().pushToast('error', `${c.name} didn't take that: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const rename = async (id: string) => {
    if (renameText.trim()) setComputers(await window.nekko.renameComputer(id, renameText.trim()));
    setRenaming(null);
  };

  const makeLink = async () => {
    const made = await computerLink(window.nekko);
    setLinkNote('note' in made ? made.note : null);
    setLink('link' in made ? made.link : '');
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2">
        <ComputerIcon className="h-4 w-4" />
        <h2 className="font-semibold">Computers</h2>
        <button className="btn btn-primary ml-auto py-1 text-xs" onClick={() => { setAdding(!adding); setError(null); }}>
          Add a computer
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        See and run agents on your other computers from here. Each one stays on its own machine, with its own files, models and accounts.
      </p>

      {adding && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-ink-soft" htmlFor="computer-link">On the other computer, open Settings, Computers, and make a link. Paste it here.</label>
          <div className="flex gap-2">
            <input id="computer-link" className="input min-w-0 flex-1 py-1 text-sm" placeholder="nekko-agent-pair:?relay=…" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button className="btn btn-primary py-1 text-xs" onClick={() => void add()} disabled={busy || !paste.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
          </div>
          {error && <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
      )}

      {computers.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          <li className="flex items-center gap-3 py-2 text-sm">
            <span aria-hidden className="h-2 w-2 shrink-0" />
            <IconPicker icon={machineIcon} label="this computer" onPick={(icon) => void window.nekko.updateSettings({ machineIcon: icon }).then(() => refreshSettings())} />
            <span className="min-w-0 flex-1 font-medium">This computer</span>
          </li>
          {computers.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2 text-sm">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATE_COLOR[c.state] }} />
              <IconPicker icon={c.icon} label={c.name} onPick={(icon) => void setIcon(c, icon)} />
              <div className="min-w-0 flex-1">
                {renaming === c.id ? (
                  <input
                    className="input max-w-[220px] py-0.5 text-xs"
                    aria-label={`Name for ${c.name}`}
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => void rename(c.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void rename(c.id); if (e.key === 'Escape') setRenaming(null); }}
                  />
                ) : (
                  <button className="truncate text-left font-medium" title="Rename" onClick={() => { setRenaming(c.id); setRenameText(c.name); }}>{c.name}</button>
                )}
                <p className="truncate text-xs text-ink-faint">{computerDetail(c)}</p>
              </div>
              <button className="btn btn-ghost py-0.5 text-xs" style={{ color: 'var(--danger)' }} onClick={() => void forget(c)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-sm font-medium">Let a computer connect to this one</h3>
        <p className="mt-1 text-xs text-ink-faint">
          Connecting works one way. A computer that connects here can run agents here with no prompt for each change, and an agent in YOLO mode can do anything your account can. Only connect a computer you trust like this one.
        </p>
        <button className="btn btn-outline mt-2 py-1 text-xs" onClick={() => void makeLink()}>Make a link</button>
        {linkNote && <p className="mt-2 text-xs text-ink-soft">{linkNote}</p>}
        {link && (
          <div className="mt-2">
            <code className="block break-all rounded-md bg-surface-2 p-2 text-2xs">{link}</code>
            <button className="btn btn-outline mt-2 py-1 text-xs" onClick={() => void navigator.clipboard?.writeText(link)}>Copy</button>
            <p className="mt-1 text-2xs text-ink-faint">Works once, for 10 minutes. It holds this computer's keys, so keep it private.</p>
          </div>
        )}
      </div>
    </section>
  );
}
