import { toolPurpose, type PurposeCall, type ToolPurpose } from '@nekko-agent/shared';
import { BranchIcon, CheckIcon, FileIcon, FolderIcon, GlobeIcon, ListIcon, PencilIcon, SearchIcon, ToolStepIcon } from '../../icons.js';
import { ReplyActivityIcon } from './ReplyStatus.js';

export type ToolIconKind = 'read' | 'search' | 'list' | 'edit' | 'check' | 'terminal' | 'git' | 'web' | 'plan' | 'other';

const key = (name: string) => name.replace(/^functions\./, '').toLowerCase().replace(/[-_\s]/g, '');
const READ = new Set(['readfile', 'read', 'view', 'openfile', 'notebookread', 'readmanyfiles', 'cat']);
const LIST = new Set(['listdir', 'ls', 'listdirectory', 'listfiles']);
const SHELL = new Set(['bash', 'shell', 'runcommand', 'runterminalcmd', 'exec', 'execcommand', 'powershell', 'terminal', 'localshell', 'runshellcommand', 'startprocess', 'readprocess', 'killprocess', 'bashoutput', 'killshell', 'killbash']);

/** Same purpose classifier as the row's headline; distinguish reading from finding. */
export function toolIconKind(call: PurposeCall): ToolIconKind {
  const name = call.name.replace(/^functions\./, '');
  const normalized = key(name);
  const purpose = toolPurpose({ ...call, name });
  if (purpose === 'check' || purpose === 'git' || purpose === 'edit' || purpose === 'web' || purpose === 'plan') return purpose;
  if (SHELL.has(normalized)) return 'terminal';
  if (purpose === 'guidance' || READ.has(normalized)) return 'read';
  if (LIST.has(normalized)) return 'list';
  if (purpose === 'explore') return 'search';
  return 'other';
}

export function purposeIconKind(purpose: ToolPurpose, calls: PurposeCall[]): ToolIconKind {
  const kinds = calls.map(toolIconKind);
  if (kinds.length && kinds.every(k => k === kinds[0])) return kinds[0];
  switch (purpose) {
    case 'guidance': return 'read';
    case 'explore': return 'search';
    case 'edit': case 'check': case 'git': case 'web': case 'plan': return purpose;
    case 'run': return 'terminal';
    default: return 'other';
  }
}

const ICONS = { read: FileIcon, search: SearchIcon, list: FolderIcon, edit: PencilIcon, check: CheckIcon, git: BranchIcon, web: GlobeIcon, plan: ListIcon, other: ToolStepIcon };

/** Transcript icons are static, including the live status terminal's shared artwork. */
export function ToolActivityIcon({ kind, className = 'h-3 w-3 shrink-0 text-accent' }: { kind: ToolIconKind; className?: string }) {
  const Icon = kind === 'terminal' ? null : ICONS[kind];
  return <span data-tool-icon={kind} className="inline-flex shrink-0 self-center" aria-hidden="true">
    {Icon ? <Icon className={className} /> : <span className={className}><ReplyActivityIcon state="terminal" size={12} stationary /></span>}
  </span>;
}
