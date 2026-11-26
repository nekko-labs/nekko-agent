import type { ChatEngineId, EngineInstall, EngineOption, EngineStatus } from '@nekko-agent/shared';

/** What a row's install, uninstall and download progress go through. */
export type EngineRuntime = 'llama' | 'mlx' | 'diffusion';

/** One engine in the Engines block, and the one thing its row offers. */
export interface EngineRow {
  id: ChatEngineId | 'diffusion';
  name: string;
  /** What it is, or why this machine cannot run it. */
  detail: string;
  /** This machine cannot run it (or Nekko cannot yet): shown, never picked. */
  disabled: boolean;
  labels: string[];
  inUse: boolean;
  installed: boolean;
  /** The version, or whose install it is when it is not ours. */
  meta?: string;
  runtime?: EngineRuntime;
  /** `use` puts an installed engine in use; `install` downloads one this machine can run. */
  action: 'use' | 'install' | null;
  /** The one primary button: the fastest engine this machine can run and does not have yet. */
  primary: boolean;
  /** Only an install Nekko made is removed here. */
  removable: boolean;
}

export interface EngineGroup {
  id: 'chat' | 'image';
  title: string;
  rows: EngineRow[];
}

const LABELS: Record<NonNullable<EngineOption['labels']>[number], string> = { fastest: 'Fastest', stable: 'Most stable' };

function meta(installed: boolean, version?: string, source?: string): string | undefined {
  if (!installed) return undefined;
  return source === 'external' ? [version, 'your own install'].filter(Boolean).join(' · ') : version;
}

function chatRows(engines: EngineOption[]): EngineRow[] {
  const using = engines.findIndex((e) => e.inUse);
  // The fastest engine not yet here is the one to get: it sits above the one in use.
  const next = engines.findIndex((e, i) => e.state === 'usable' && !e.installed && e.runtime && (using < 0 || i < using));
  return engines.map((e, i) => {
    const usable = e.state === 'usable';
    const installed = usable && Boolean(e.installed);
    return {
      id: e.id,
      name: e.name,
      detail: usable ? e.detail : e.reason ?? e.detail,
      disabled: !usable,
      labels: (e.labels ?? []).map((l) => LABELS[l]),
      inUse: Boolean(e.inUse),
      installed,
      meta: meta(installed, e.version, e.source),
      runtime: usable ? e.runtime : undefined,
      action: !usable ? null : installed ? (e.inUse ? null : 'use') : e.runtime ? 'install' : null,
      primary: i === next,
      removable: installed && e.source === 'managed',
    };
  });
}

/** stable-diffusion.cpp is the only image engine, so installed is in use. Hidden where it has no build. */
function imageRows(install?: EngineInstall): EngineRow[] {
  if (!install || (!install.binPath && !install.available.length)) return [];
  const installed = Boolean(install.binPath);
  return [{
    id: 'diffusion',
    name: 'stable-diffusion.cpp',
    detail: 'Runs SD3.5, FLUX and other image models.',
    disabled: false,
    labels: [],
    inUse: installed,
    installed,
    meta: meta(installed, install.version, install.source),
    runtime: 'diffusion',
    action: installed ? null : 'install',
    primary: false,
    removable: installed && install.source === 'managed',
  }];
}

/** The Engines block's groups for a status read; a group with no rows is left out. */
export function engineGroups(status: Pick<EngineStatus, 'engines' | 'diffusionInstall'> | null): EngineGroup[] {
  if (!status) return [];
  const groups: EngineGroup[] = [
    { id: 'chat', title: 'Chat models', rows: chatRows(status.engines ?? []) },
    { id: 'image', title: 'Photo and video models', rows: imageRows(status.diffusionInstall) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** The chat engine in use, for the folded block's one line and the Find tab's format. */
export function engineInUse(status: Pick<EngineStatus, 'engines'> | null): EngineOption | undefined {
  return status?.engines?.find((e) => e.inUse);
}

/** Whether the engine in use reads MLX folders, so finding a model starts on those. */
export function prefersMlx(status: Pick<EngineStatus, 'engines'> | null): boolean {
  const id = engineInUse(status)?.id;
  return id === 'mlx' || id === 'omlx';
}
