import { computerColor, computerIdOf, type ComputerIcon, type ComputerStatus } from '@nekko-agent/shared';
import { COMPUTER_ICON_GLYPHS } from '../icons.js';
import { useStore } from '../store.js';

/** The computer a chat or folder runs on, or null when it runs here. */
export function useComputerOf(id: string | null | undefined): ComputerStatus | null {
  const computerId = computerIdOf(id);
  return useStore((s) => (computerId ? s.computers.find((c) => c.id === computerId) ?? null : null));
}

/** Why a chat on another computer can't take a message right now, or null when it can. */
export function computerBlock(c: ComputerStatus | null): string | null {
  if (!c) return null;
  if (c.state === 'online') return c.change ? null : `${c.name} allows watching only`;
  if (c.state === 'connecting') return `Connecting to ${c.name}`;
  if (c.state === 'denied') return `${c.name} removed this computer. Connect it again in Settings.`;
  if (c.state === 'update') return `Update Nekko Agent on ${c.name}`;
  return `${c.name} is offline`;
}

/** A computer's icon, or nothing: there is no default. */
export function ComputerGlyph({ icon, className = 'h-3 w-3 shrink-0' }: { icon?: string; className?: string }) {
  const Glyph = icon ? COMPUTER_ICON_GLYPHS[icon as ComputerIcon] : undefined;
  return Glyph ? <span aria-hidden data-computer-icon={icon}><Glyph className={className} /></span> : null;
}

/** Where an agent runs. Local agents have none: with a second computer the absence reads as "here". */
export function ComputerChip({ computer, dim, showIcon = true }: { computer: ComputerStatus; dim?: boolean; showIcon?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 truncate text-2xs font-medium" data-computer-chip={computer.id} style={{ color: computerColor(computer), opacity: dim ? 0.6 : undefined }}>
      {showIcon && <ComputerGlyph icon={computer.icon} />}
      {computer.name}
    </span>
  );
}
