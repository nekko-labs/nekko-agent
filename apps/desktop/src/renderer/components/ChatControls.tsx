import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMode, McpServerStatus, Session } from '@nekko-agent/shared';
import { getExecutionMode, type ExecutionMode } from '@nekko-agent/shared';
import { SandboxSetup, SandboxReview } from './SandboxSetup.js';
import { useStore } from '../store.js';
import { WrenchIcon, PlaneIcon, IncognitoIcon, PlugIcon, PlusIcon, GlobeIcon, GlobeOffIcon } from '../icons.js';
import { afterPaint } from '../afterPaint.js';

/** Where we point people for hardened, local-first MCP server management. */
const HYPERGATE_URL = 'https://hypergate.app';

/**
 * MCP servers menu, parked just right of Tools in the execution row. Lists every
 * configured MCP server with a live status dot, its name, and an enable/disable
 * toggle; offers "Add MCP server" (jumps to Settings) and recommends Hypergate
 * for managing servers securely. Server enablement is global (in settings), so
 * turning one on offers its tools to every chat.
 */
/**
 * Place a menu next to its trigger in a portal, above it when there is more room
 * there. The agent window clips its overflow, so a menu drawn inside its footer
 * would be cut off; this one floats over everything instead.
 */
function useFloatingMenu(open: boolean, anchor: React.RefObject<HTMLElement | null>, width: number) {
  const [style, setStyle] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const above = Math.max(0, r.top - 16);
      const below = Math.max(0, window.innerHeight - r.bottom - 16);
      const w = Math.min(width, window.innerWidth - 16);
      setStyle({
        width: w,
        left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)),
        maxHeight: Math.min(360, Math.max(above, below)),
        ...(above >= below ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      });
    };
    place();
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, anchor, width]);
  return style;
}

export function McpMenu() {
  const servers = useStore((s) => s.settings?.mcpServers) ?? [];
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<McpServerStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const floating = useFloatingMenu(open, button, 288);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Probe live connection status the first time the menu opens (getMcpStatus can
  // spawn/dial servers, so we don't do it on every render).
  useEffect(() => {
    if (!open || status !== null || servers.length === 0) return;
    setChecking(true);
    window.nekko.getMcpStatus()
      .then(setStatus)
      .catch(() => setStatus([]))
      .finally(() => setChecking(false));
  }, [open, status, servers.length]);

  const enabledCount = servers.filter((s) => s.enabled).length;
  const statusOf = (id: string) => status?.find((s) => s.id === id);

  const toggle = async (id: string) => {
    const next = servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
    await window.nekko.updateSettings({ mcpServers: next });
    await useStore.getState().refreshSettings();
    // Config changed: re-probe so the dots reflect the new enablement.
    setStatus(null);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={button}
        className="ctl-menu whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="MCP servers whose tools are offered to your chats"
      >
        <PlugIcon className="h-3 w-3 text-ink-faint" />
        <span className="ctl-menu-label">MCP</span>
        <span className="tabular-nums">{enabledCount}/{servers.length}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {open && createPortal(
        <div ref={pop} style={floating} className="card fixed z-[100] overflow-y-auto p-1.5 shadow-lg" role="menu" aria-label="MCP servers">
          {servers.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-ink-faint">
              No MCP servers yet. Add one to extend every chat with its tools.
            </p>
          )}
          {servers.length > 0 && (
            <div className="max-h-64 overflow-y-auto">
              {servers.map((s) => {
                const st = statusOf(s.id);
                const dot = !s.enabled
                  ? 'var(--ink-faint)'
                  : st
                    ? (st.connected ? 'var(--success)' : 'var(--danger)')
                    : 'var(--warning)';
                const sub = !s.enabled
                  ? (s.url != null ? 'http · off' : 'stdio · off')
                  : st
                    ? (st.connected ? `${s.url != null ? 'http' : 'stdio'} · ${st.tools.length} tools` : (st.error ? `offline · ${st.error}` : 'offline'))
                    : (checking ? 'checking…' : (s.url != null ? 'http' : 'stdio'));
                return (
                  <button
                    key={s.id}
                    role="menuitemcheckbox"
                    aria-checked={s.enabled}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => toggle(s.id)}
                    title={s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px]">{s.name}</span>
                      <span className="block truncate text-[10.5px] text-ink-faint">{sub}</span>
                    </span>
                    {/* Enable/disable switch */}
                    <span
                      className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                      style={{ background: s.enabled ? 'var(--accent)' : 'color-mix(in srgb, var(--ink-faint) 40%, transparent)' }}
                      aria-hidden="true"
                    >
                      <span
                        className="absolute h-3 w-3 rounded-full bg-white shadow-sm transition-transform"
                        style={{ transform: s.enabled ? 'translateX(14px)' : 'translateX(2px)' }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <button
              role="menuitem"
              className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-accent hover:bg-surface-2"
              onClick={() => { setOpen(false); useStore.getState().setView('settings'); }}
            >
              <PlusIcon className="h-3.5 w-3.5" /> Add MCP server
            </button>
            <button
              role="menuitem"
              className="flex w-full items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-ink-faint hover:bg-surface-2"
              onClick={() => window.nekko.openPath(HYPERGATE_URL)}
              title="Hypergate: local-first, secure MCP server management"
            >
              <ShieldSmall />
              <span>Manage servers securely with <span className="font-medium text-ink-soft">Hypergate</span> ↗</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * Which tools this chat may call, as a picker. Lives in the agent window's
 * footer beside MCP: what the agent can use reads together with what it can
 * reach. Tools are off while the chat is blocked from the internet.
 */
export function ToolsMenu({ session, onChange }: { session: Session; onChange: (s: Session | null) => void }) {
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const floating = useFloatingMenu(open, button, 256);
  // After the first frame: a pane that just opened paints before it asks.
  useEffect(() => afterPaint(() => { window.nekko.listTools().then(setTools).catch(() => {}); }), []);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus({ preventScroll: true }); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const offline = !!session.offline;
  const disabled = new Set(session.disabledTools ?? []);
  const availableTools = getExecutionMode(session) === 'sandbox' ? tools.filter((t) => ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash'].includes(t.name)) : tools;
  const enabledCount = availableTools.filter((t) => !disabled.has(t.name)).length;
  const shown = query.trim() ? availableTools.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase())) : availableTools;
  const toggle = async (name: string) => {
    const next = new Set(disabled);
    next.has(name) ? next.delete(name) : next.add(name);
    onChange(await window.nekko.setSessionOptions(session.id, { disabledTools: [...next] } as Partial<Session> as any));
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={button}
        className="ctl-menu whitespace-nowrap"
        onClick={() => { setOpen((o) => !o); setQuery(''); }}
        disabled={offline}
        aria-haspopup="menu"
        aria-expanded={open}
        title={offline ? 'Tools are off while internet access is blocked' : 'Enable/disable tools for this chat'}
      >
        <WrenchIcon className="h-3 w-3 text-ink-faint" />
        <span className="ctl-menu-label">Tools</span>
        <span className="tabular-nums">{offline ? 'off' : `${enabledCount}/${availableTools.length}`}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {open && !offline && createPortal(
        <div ref={pop} style={floating} className="card fixed z-[100] flex flex-col p-1.5 shadow-lg" role="menu" aria-label="Tools">
          {availableTools.length > 7 && (
            <input className="input mb-1 rounded-lg px-2.5 py-1 text-[12px]" placeholder="Filter tools…" value={query} autoFocus aria-label="Filter tools" onChange={(e) => setQuery(e.target.value)} />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">No tools match.</p>}
            {shown.map((t) => {
              const on = !disabled.has(t.name);
              return (
                <button key={t.name} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2" onClick={() => void toggle(t.name)} title={t.description} role="menuitemcheckbox" aria-checked={on}>
                  <span className="mt-0.5 text-[12px]" style={{ color: on ? 'var(--accent)' : 'var(--ink-faint)' }}>{on ? '☑' : '☐'}</span>
                  <span className="min-w-0">
                    <span className="block font-mono text-[12px]">{t.name.startsWith('mcp__') ? `🔌 ${t.name.split('__').slice(2).join('__')}` : t.name}</span>
                    <span className="block truncate text-[11px] text-ink-faint">{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * This agent's internet access as one icon toggle: a globe when it may reach
 * the internet, the globe struck through when it is blocked. Blocking it is
 * the chat's Offline mode (no tools, connectors or network).
 */
export function InternetToggle({ session, onToggle, cloudModel = false }: { session: Session | null; onToggle: () => void; cloudModel?: boolean }) {
  const blocked = !!session?.offline;
  // A cloud model is reached over the internet, so it cannot be blocked from it;
  // an already-blocked chat can always be allowed again.
  const locked = cloudModel && !blocked;
  const hint = locked
    ? 'Internet allowed: this agent uses a cloud model, so it needs internet connectivity. Pick a local model to block internet access.'
    : blocked
      ? 'Internet blocked for this agent. Click to allow internet connectivity.'
      : 'Internet allowed for this agent. Click to block internet connectivity.';
  return (
    <button
      type="button"
      className="agent-internet-toggle inline-flex h-6 w-6 items-center justify-center rounded-md"
      data-internet={blocked ? 'blocked' : 'allowed'}
      aria-label={blocked ? 'Allow internet connectivity for this agent' : 'Block internet connectivity for this agent'}
      aria-pressed={!blocked}
      title={hint}
      disabled={locked}
      onClick={onToggle}
    >
      {blocked ? <GlobeOffIcon className="h-3.5 w-3.5" /> : <GlobeIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

/** A tiny shield glyph for the Hypergate recommendation row. */
function ShieldSmall() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-accent">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export const MODE_LABEL: Record<ChatMode, string> = { ask: 'Ask', guardrails: 'Guardrails', yolo: 'YOLO' };
const MODE_DESC: Record<ChatMode, string> = {
  ask: 'Confirm every file write and command.',
  guardrails: 'Run freely; ask/deny per guardrail rules.',
  yolo: 'Run everything (deny rules still block).',
};

/**
 * The per-chat execution row of the instrument strip above the composer: how
 * tools run (mode, which tools) on the left, and the two privacy switches
 * (Offline, Incognito) parked on the right behind a hairline divider, so
 * "what this agent may do" reads apart from "what it may reach".
 *
 * The two families look different on purpose: value pickers are bordered fields
 * with a caret (`.ctl-menu`), switches are quiet until hovered and show their
 * on-state with color and a lit dot rather than a filled pill (`.ctl-toggle`).
 */
export function ChatControls({
  session,
  isCloudModel,
  onChange,
  leading,
  toolsInWindow = false,
  only,
}: {
  session: Session | null;
  isCloudModel: boolean;
  onChange: (s: Session | null) => void;
  /** Tools and MCP live in the agent window's footer, so the wall composer leaves them out. */
  toolsInWindow?: boolean;
  /** Drawn first on the row (the chat-type toggle). */
  leading?: ReactNode;
  /** Render just one control, for a host that lays them out itself (the wall composer's bottom bar). */
  only?: 'mode' | 'privacy';
}) {
  const defaultChatMode = useStore((s) => s.settings?.defaultChatMode);
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [executionError, setExecutionError] = useState('');
  const modeButton = useRef<HTMLButtonElement>(null);
  const modeMenu = useRef<HTMLDivElement>(null);
  const [modePosition, setModePosition] = useState<React.CSSProperties>({});
  // Escape the Grid composer's scroll clipping, just like the model picker.
  useLayoutEffect(() => {
    if (!modeOpen) return;
    const position = () => {
      const anchor = modeButton.current?.getBoundingClientRect();
      if (!anchor) return;
      const above = Math.max(0, anchor.top - 16);
      const below = Math.max(0, window.innerHeight - anchor.bottom - 16);
      const width = Math.min(480, window.innerWidth - 16);
      setModePosition({
        width, left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        maxHeight: Math.max(above, below),
        ...(above >= below ? { bottom: window.innerHeight - anchor.top + 8 } : { top: anchor.bottom + 8 }),
      });
    };
    position();
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => { document.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); };
  }, [modeOpen]);
  const [toolQuery, setToolQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // After the first frame: a pane that just opened paints before it asks.
  useEffect(() => afterPaint(() => { window.nekko.listTools().then(setTools); }), []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !modeMenu.current?.contains(e.target as Node)) { setToolsOpen(false); setModeOpen(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setToolsOpen(false); setModeOpen(false); if (modeMenu.current) modeButton.current?.focus({ preventScroll: true }); }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  if (!session) return null;

  const execution = getExecutionMode(session);
  const sandbox = execution === 'sandbox';
  const selectExecution = async (executionMode: ExecutionMode) => {
    setModeOpen(false); setExecutionError('');
    if (executionMode === 'sandbox') { setSetupOpen(true); return; }
    try {
      onChange(await window.nekko.setSessionOptions(session.id, { executionMode, gitIsolation: executionMode === 'worktree' }));
      await window.nekko.updateSettings({ defaultExecutionMode: executionMode, gitManagement: { ...useStore.getState().settings?.gitManagement, mode: executionMode === 'worktree' ? 'worktree' : 'shared' } });
      await useStore.getState().refreshSettings();
    } catch (e) { setExecutionError(String((e as Error).message ?? e)); }
  };
  const mode: ChatMode = session.mode ?? defaultChatMode ?? 'guardrails';
  const disabled = new Set(session.disabledTools ?? []);
  const availableTools = sandbox ? tools.filter((t) => ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash'].includes(t.name)) : tools;
  const enabledCount = availableTools.filter((t) => !disabled.has(t.name)).length;
  const offline = !!session.offline;
  const incognito = !!session.incognito;
  const shownTools = toolQuery.trim()
    ? availableTools.filter((t) => t.name.toLowerCase().includes(toolQuery.trim().toLowerCase()))
    : availableTools;

  const patch = async (p: Partial<Session>) => {
    const next = await window.nekko.setSessionOptions(session.id, p as any);
    onChange(next);
  };

  const toggleTool = (name: string) => {
    const next = new Set(disabled);
    next.has(name) ? next.delete(name) : next.add(name);
    patch({ disabledTools: [...next] });
  };

  const showMode = only !== 'privacy';
  const showPrivacy = only !== 'mode';
  return (
    <div ref={ref} className={only ? 'flex min-w-0 items-center gap-1 text-[12px]' : 'flex w-full min-w-0 flex-wrap items-center gap-1.5 text-[12px]'}>
      {!only && leading}
      {/* An image chat runs no agent: no tool policy, tools or MCP to set. */}
      {session.chatType !== 'image' && showMode && (<>
      {/* Mode */}
      {/* In a composer's footer (`only`) the label shrinks and truncates
          rather than overflowing under the mic beside it on a narrow window. */}
      <div className={only ? 'relative min-w-0' : 'relative shrink-0'}>
        <button
          ref={modeButton}
          className="ctl-menu max-w-full whitespace-nowrap"
          onClick={() => { setModeOpen((o) => !o); setToolsOpen(false); }}
          aria-haspopup="menu"
          aria-expanded={modeOpen}
          title={MODE_DESC[mode]}
        >
          <span className="ctl-menu-label">Mode</span>
          <span className="min-w-0 truncate">{execution === 'worktree' ? 'Worktree' : sandbox ? 'Sandbox' : 'Unified'} - {MODE_LABEL[mode]}</span>
          <span className="ctl-caret">▾</span>
        </button>
        {modeOpen && createPortal(
          <div ref={modeMenu} style={modePosition} className="card fixed z-[100] overflow-y-auto p-1.5 shadow-lg" role="menu" aria-label="Chat mode">
            <div className="grid grid-cols-2 gap-2">
            <div><p className="px-2.5 text-[11px] text-ink-faint">Execution</p>
              {([{ value: 'sandbox', label: 'Sandbox', description: 'Scoped files and bash in a local container.' }, { value: 'worktree', label: 'Worktree', description: 'Isolated Git checkout from committed HEAD.' }, { value: 'unified', label: 'Unified', description: 'Share current folders and local changes.' }] as const).map((item) => <button key={item.value} role="menuitemradio" aria-checked={execution === item.value} className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2" onClick={() => void selectExecution(item.value)}><span className="text-[13px] font-medium">{item.label}</span><span className="text-[11px] text-ink-faint">{item.description}</span></button>)}
            </div><div><p className="px-2.5 text-[11px] text-ink-faint">Permissions</p>
            {(['ask', 'guardrails', 'yolo'] as ChatMode[]).map((m) => (
              <button
                key={m}
                role="menuitemradio"
                data-chat-mode={m}
                aria-checked={mode === m}
                className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${mode === m ? 'text-accent' : ''}`}
                onClick={() => { patch({ mode: m }); setModeOpen(false); modeButton.current?.focus({ preventScroll: true }); }}
              >
                <span className="text-[13px] font-medium">{MODE_LABEL[m]}{m === 'guardrails' ? ' (recommended)' : ''}</span>
                <span className="text-[11px] text-ink-faint">{MODE_DESC[m]}</span>
              </button>
            ))}
            </div></div>
          </div>, document.body
        )}
      </div>

      {executionError && <p role="alert" className="text-danger">{executionError}</p>}
      {setupOpen && <SandboxSetup session={session} onChange={onChange} onClose={() => setSetupOpen(false)} />}
      {sandbox && <><span className="text-[11px] text-ink-faint">Scoped files/bash only; host previews, hooks and MCP unavailable.</span><button className="ctl-menu" onClick={() => setSetupOpen(true)}>Sandbox setup</button><SandboxReview sessionId={session.id} /></>}
      {/* Tools */}
      {!toolsInWindow && !only && <div className="relative shrink-0">
        <button
          className="ctl-menu whitespace-nowrap"
          onClick={() => { setToolsOpen((o) => !o); setModeOpen(false); setToolQuery(''); }}
          disabled={offline}
          aria-haspopup="menu"
          aria-expanded={toolsOpen}
          title={offline ? 'Tools are off in Offline mode' : 'Enable/disable tools for this chat'}
        >
          <WrenchIcon className="h-3 w-3 text-ink-faint" />
          <span className="ctl-menu-label">Tools</span>
          <span className="tabular-nums">{offline ? 'off' : `${enabledCount}/${tools.length}`}</span>
          <span className="ctl-caret">▾</span>
        </button>
        {toolsOpen && !offline && (
          <div className="card absolute bottom-8 left-0 z-40 flex max-h-80 w-64 flex-col p-1.5 shadow-lg">
            {tools.length > 7 && (
              <input
                className="input mb-1 rounded-lg px-2.5 py-1 text-[12px]"
                placeholder="Filter tools…"
                value={toolQuery}
                autoFocus
                aria-label="Filter tools"
                onChange={(e) => setToolQuery(e.target.value)}
              />
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {shownTools.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">No tools match.</p>}
              {shownTools.map((t) => {
                const on = !disabled.has(t.name);
                return (
                  <button
                    key={t.name}
                    className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => toggleTool(t.name)}
                    title={t.description}
                    role="menuitemcheckbox"
                    aria-checked={on}
                  >
                    <span className="mt-0.5 text-[12px]" style={{ color: on ? 'var(--accent)' : 'var(--ink-faint)' }}>{on ? '☑' : '☐'}</span>
                    <span className="min-w-0">
                      <span className="block font-mono text-[12px]">
                        {t.name.startsWith('mcp__') ? `🔌 ${t.name.split('__').slice(2).join('__')}` : t.name}
                      </span>
                      <span className="block truncate text-[11px] text-ink-faint">{t.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>}

      {/* MCP servers, right of Tools: their tools are what the agent can reach. */}
      {!toolsInWindow && !only && (sandbox ? <span title="MCP is unavailable in Sandbox">MCP unavailable</span> : <McpMenu />)}
      </>)}

      {/* The privacy switches sit apart from the execution controls: pushed to
          the right edge of the row, behind a hairline. */}
      {showPrivacy && <div className={only ? 'flex shrink-0 items-center gap-1' : 'ml-auto flex shrink-0 items-center gap-1'}>
        {!only && <span className="mr-0.5 h-4 w-px bg-line" aria-hidden="true" />}

        {/* Offline: the agent window's footer carries it as the internet toggle. */}
        {!toolsInWindow && <button
          className="ctl-toggle whitespace-nowrap"
          onClick={() => !isCloudModel && patch({ offline: !offline })}
          disabled={isCloudModel}
          aria-pressed={offline}
          title={isCloudModel ? 'Offline mode is only for local models' : 'No tools, no connectors, no internet'}
        >
          <span className="ctl-dot" />
          <PlaneIcon className="h-3 w-3" /> Offline
        </button>}

        {/* Incognito */}
        <button
          className="ctl-toggle ctl-toggle-neutral whitespace-nowrap"
          onClick={() => patch({ incognito: !incognito })}
          aria-pressed={incognito}
          title="Don't save this chat or update memory"
        >
          <span className="ctl-dot" />
          <IncognitoIcon className="h-3.5 w-3.5" /> <span className="foot-label">Incognito</span>
        </button>
      </div>}
    </div>
  );
}
