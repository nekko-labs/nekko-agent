// Real shared icon exports, synthetic controls only. No host or network access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { InfoIcon, FolderIcon, TerminalIcon, ServerIcon, SendIcon, LockIcon, GaugeIcon } from '../src/renderer/icons';
import { SidebarCollapseIcon, SidebarExpandIcon, FocusIcon, ShieldQuestionIcon, BrainCircuitIcon, WorkflowIcon, RouterIcon, LogOutIcon, CheckCircleIcon } from '../src/renderer/gentleface-icons';
import '../src/renderer/styles.css';
import '@fontsource-variable/inter-tight';
const icons = { Info: InfoIcon, Files: FolderIcon, Terminal: TerminalIcon, Server: ServerIcon, Send: SendIcon, Privacy: LockIcon, Effort: GaugeIcon, Collapse: SidebarCollapseIcon, Expand: SidebarExpandIcon, Focus: FocusIcon, Permissions: ShieldQuestionIcon, Memory: BrainCircuitIcon, Workflow: WorkflowIcon, Router: RouterIcon, SignOut: LogOutIcon, Complete: CheckCircleIcon };
createRoot(document.getElementById('root')!).render(<main style={{ padding: 28, color: 'var(--ink)', background: 'var(--surface)', minHeight: '100vh' }}>
  <h1 style={{ fontSize: 22, marginBottom: 12 }}>Nekko Agent controls</h1>
  <p style={{ marginBottom: 24 }}>Hover or focus a control to play its Gentleface animation once.</p>
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>{Object.entries(icons).map(([name, Icon]) => <button key={name} data-name={name} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 14, border: '1px solid var(--line)', borderRadius: 12 }}><Icon className="h-4 w-4" />{name}</button>)}</div>
  <button data-name="Disabled" disabled style={{ marginTop: 24 }}><SendIcon className="h-4 w-4" /> Disabled send</button>
</main>);
