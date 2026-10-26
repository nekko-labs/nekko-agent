import React, { memo } from 'react';
import type { BlockedReason, PrInfo, SessionLane, SessionSummary, TerminalInfo, WorkspaceFolder } from '@nekko-agent/shared';
import { getSessionWorkspaceIds, guessContextWindow, isLocalProvider, reportedClaudeCodeContext } from '@nekko-agent/shared';
import { useStore, type Workspace } from '../store.js';
import { allPanes } from '../layout.js';
import { useGitStatus } from '../useGitStatus.js';
import {
  BranchIcon, CheckIcon, CloseIcon, CompactIcon, QuestionIcon, RobotIcon, RocketIcon, SleepIcon, TerminalIcon,
  WarningIcon, WorktreeIcon,
} from '../icons.js';
import { COMPLETION_ROW_ATTR, completeWithExit } from '../completionExit.js';
import { useCompactionStore } from '../compactionStatus.js';
import { fillTone } from './contextTone.js';
import { SessionPrLinks } from './SessionPrLinks.js';

/**
 * One workspace, as a card in the left sidebar.
 *
 * What the agent is running used to be a panel at the foot of the sidebar that
 * described whichever chat was open — one card for all of them, four glances
 * away from the chat it was about. The facts belong to the workspace, so they
 * live on the workspace.
 *
 * The card states them in a fixed order, so the same fact is always in the same
 * place and a column of cards can be read down rather than each one decoded:
 *
 * 1. **Who and how it is.** Status dot, title, when it last replied.
 * 2. **What is running it.** Which model it is ("Opus 5.5") and how full its
 *    context window is, with where the model comes from ("Claude") as subtext
 *    on the line under it, which the view menu can hide.
 * 3. **What it has shipped from where.** The branch (with the worktree glyph
 *    when it is a linked worktree), then each PR the chat made as its own
 *    link (`SessionPrLinks`). The project is not repeated: the card already
 *    sits under its project's heading.
 * 4. **What it has spun up.** Sub-agents and windows.
 *
 * Colour is load-bearing rather than decorative. Every fact carries the hue of
 * what it *is* (a branch is always the same colour, a limit is the colour of
 * how close to spent it is), so the eye can find the branch without reading.
 * A chat workspace gets an accent spine and a tinted active state; a terminal
 * workspace deliberately does not, because the chat is the thing this app is
 * about and a sidebar where everything shouts says nothing.
 */

export type AgentStatus = 'working' | 'input' | 'error' | 'done' | 'idle';

/** A board lane as the glyph `StatusIcon` draws: an interrupted turn is an error, any other block needs input. */
export function agentStatusOfLane(lane: SessionLane, blocked?: BlockedReason, activeWatchCount = 0): AgentStatus {
  if (lane === 'working') return 'working';
  if (lane !== 'needs-you') return activeWatchCount > 0 ? 'idle' : 'done';
  return blocked === 'interrupted' ? 'error' : 'input';
}

/**
 * What an agent is doing, as a glyph rather than a dot, so the state reads by
 * shape before colour: a rocket in flight while it works, a question mark when
 * it is waiting on you, a warning when it stopped on an error, a gray check when it
 * has finished, and "Zz" when an armed watch keeps it idle. `undefined` is done.
 */
export function StatusIcon({ status, className = '' }: { status: AgentStatus | undefined; className?: string }) {
  const cls = `h-3 w-3 shrink-0 ${className}`;
  if (status === 'working') {
    return (
      <span className={`status-rocket inline-grid place-items-center ${cls}`} title="Working…" role="img" aria-label="Working">
        <RocketIcon className="h-4 w-4" />
      </span>
    );
  }
  if (status === 'input') {
    return (
      // Drawn larger than its slot, like the rocket, so the one state that is
      // waiting on you stands out without pushing the title over.
      <span className={`inline-grid place-items-center ${cls}`} style={{ color: 'var(--attention)' }} title="Needs your input" role="img" aria-label="Needs your input">
        <QuestionIcon className="h-4 w-4" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className={`inline-grid place-items-center ${cls}`} style={{ color: 'var(--danger)' }} title="Stopped on an error" role="img" aria-label="Stopped on an error">
        <WarningIcon className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className={`inline-grid place-items-center text-ink-faint ${cls}`} title={status === 'idle' ? 'Idle · watching' : 'Done'} role="img" aria-label={status === 'idle' ? 'Idle, watching' : 'Done'}>
      {status === 'idle' ? <SleepIcon className="h-3 w-3" /> : <CheckIcon className="h-3 w-3" />}
    </span>
  );
}

/**
 * One fact on a card: a tinted glyph and its value, in the hue of whatever kind
 * of fact it is. Tinted rather than filled, so a card with five of them still
 * reads as one card.
 */
function Fact({
  tone,
  icon,
  children,
  title,
  grow = false,
  shrink = false,
}: {
  tone?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  /** Whether this fact absorbs the spare width (and truncates) on its line. */
  grow?: boolean;
  /** Whether it may give up width (truncating) when the line runs out. */
  shrink?: boolean;
}) {
  const fluid = grow || shrink;
  return (
    <span
      className={`inline-flex items-center gap-1 ${grow ? 'min-w-0 flex-1' : shrink ? 'min-w-0 shrink' : 'shrink-0'}`}
      style={tone ? { color: tone } : undefined}
      title={title}
    >
      {icon}
      <span className={fluid ? 'min-w-0 truncate' : undefined}>{children}</span>
    </span>
  );
}

/** "4.5k" / "312k" / "1M" for a tight card line. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * A model id as a card can say it. The provider already names the vendor on
 * the same line, so "claude-opus-5-5" reads as "Opus 5.5" beside "Claude".
 */
function shortModelName(id: string, known?: string): string {
  if (known) return known.replace(/^Claude\s+/i, '');
  const claude = /^(?:.*\/)?claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  return id;
}

/** PRs by URL, the branch's own first, so one PR is never counted twice. */
function mergePrs(branchPr: PrInfo | undefined, mentioned: PrInfo[] | undefined): PrInfo[] {
  const out = new Map<string, PrInfo>();
  if (branchPr) out.set(branchPr.url, branchPr);
  for (const p of mentioned ?? []) if (!out.has(p.url)) out.set(p.url, p);
  return [...out.values()];
}

function timeAgo(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
}

function WorkspaceCardImpl({
  workspace,
  session,
  terminal,
  status,
  isActive,
  now,
  projects,
  subAgentCount = 0,
  showMetadata = true,
  showProvider = true,
  onOpen,
  onClose,
}: {
  /** The open workspace, or null for an active chat with no window open. */
  workspace: Workspace | null;
  /** The chat the workspace is about, when it is about one. */
  session: SessionSummary | null;
  /** The terminal it is about instead, for a workspace opened from a shell. */
  terminal: TerminalInfo | null;
  status: AgentStatus | undefined;
  isActive: boolean;
  now: number;
  projects: WorkspaceFolder[];
  /** How many sub-agents this chat has spawned. */
  subAgentCount?: number;
  /** The lines under the title; off, the card is its title row alone. */
  showMetadata?: boolean;
  /** The provider subtext under the model; off, the model line stands alone. */
  showProvider?: boolean;
  onOpen: () => void;
  onClose: () => void | Promise<void>;
}) {
  const providers = useStore((s) => s.providers);
  const knownModels = useStore((s) => s.models);
  const mentionedPrs = useStore((s) => (session ? s.prsBySession[session.id] : undefined));
  const liveCtxEstimate = useStore((s) => (session ? s.sessionCtxEstimate[session.id] : undefined));
  const compacting = useCompactionStore((s) => (session ? s.bySession[session.id]?.state === 'running' : false));
  const provider = providers.find((p) => p.id === session?.providerId);

  const folders = (session ? getSessionWorkspaceIds(session) : terminal?.workspaceId ? [terminal.workspaceId] : [])
    .map((id) => projects.find((w) => w.id === id))
    .filter((w): w is WorkspaceFolder => !!w);

  // Git follows the workspace's primary folder: a chat grounded in several
  // repos still *works* in one at a time, and a card has room for one branch.
  const git = useGitStatus(session ? `session:${session.id}` : folders[0]?.id);
  const prs = mergePrs(git?.pr, mentionedPrs);

  // How full this chat's context window is: the replayed transcript (text,
  // reasoning, tool traffic) against the model's window. That is the limit a
  // long run actually hits, and it is per chat, where a plan's usage limit is
  // per account and has its own Capacity panel.
  const modelInfo = session?.modelId ? knownModels.find((m) => m.id === session.modelId) : undefined;
  // An open chat publishes the composer gauge's own total (see ChatPane), so
  // the two readouts agree; a closed chat falls back to the transcript estimate.
  // A Claude Agent chat reads Claude Code's own figures instead: Nekko's
  // transcript misses Claude Code's system prompt and tools, and never drops
  // when Claude Code compacts. Before its first turn the alias guess stands.
  const reported = reportedClaudeCodeContext(session);
  const ctxUsed = liveCtxEstimate ?? reported?.used ?? session?.transcriptTokens ?? 0;
  const ctxWindow = reported?.window ?? modelInfo?.contextLength ?? guessContextWindow(session?.modelId);
  const ctxPct = ctxWindow > 0 ? (ctxUsed / ctxWindow) * 100 : 0;

  const windows = workspace ? allPanes(workspace.root).length : 0;
  const lastReply = session?.lastReplyAt;
  const title = session?.title ?? terminal?.title ?? 'Agent';
  const isChat = !!session;
  const model = session
    ? session.chatType === 'image'
      ? `🎨 ${session.imageParams?.modelId ? (session.imageParams.modelId.split('/').pop() as string) : 'No image model yet'}`
      : session.autoModel
      ? 'Auto'
      : session.modelId
        ? shortModelName(session.modelId, modelInfo?.name)
        : 'No model yet'
    : terminal
      ? terminal.shell.split(/[\\/]/).pop() || terminal.shell
      : 'Shell';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      /* The spine: a chat workspace carries an accent edge that fills in when it
         is the active one, so the thing this app is about is findable in a
         column of cards without reading a word of any of them. */
      /* A card waiting on you (a question, or stopped on an error) takes the
         active card's highlight too, so it is findable at a glance. */
      className={`group w-full cursor-pointer rounded-lg border-l py-1.5 pl-2 pr-2 text-left transition-colors duration-150 ${
        isActive || status === 'input' || status === 'error' ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
      style={{
        borderLeftColor: isChat
          ? isActive
            ? 'var(--accent)'
            : 'color-mix(in srgb, var(--accent) 30%, transparent)'
          : 'transparent',
      }}
      data-agent-active={isActive || undefined}
      title={title}
    >
      <div className="flex items-center gap-1.5">
        <StatusIcon status={status ?? (session ? agentStatusOfLane('idle', undefined, session.activeWatchCount) : 'idle')} />
        <span className={`min-w-0 flex-1 truncate text-[13px] ${isActive ? 'font-medium text-ink' : 'text-ink-soft'}`}>
          {title}
        </span>
        {lastReply && (!status || status === 'done' || status === 'idle') && (
          <time className="shrink-0 text-[10px] tabular-nums text-ink-faint" dateTime={new Date(lastReply).toISOString()} title={`Last reply ${new Date(lastReply).toLocaleString()}`}>
            {timeAgo(now - lastReply)}
          </time>
        )}
        {/* A chat card archives rather than closes: closing used to look like
            deleting and then the chat was nowhere to be found. Archived chats
            stay readable for 60 days. A shell has nothing to keep, so it closes. */}
        <button
          className="shrink-0 rounded-sm p-0.5 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          title={isChat ? 'Complete this chat (kept for 60 days)' : 'Close this agent'}
          aria-label={isChat ? `Complete ${title}` : `Close ${title}`}
          onClick={async (e) => {
            e.stopPropagation();
            if (!session) return void onClose();
            await completeWithExit(e.currentTarget.closest<HTMLElement>(`[${COMPLETION_ROW_ATTR}]`), async () => {
              await onClose();
              return useStore.getState().sessions.some((s) => s.id === session.id && s.archivedAt);
            });
          }}
        >
          <CloseIcon className={isChat ? 'h-3.5 w-3.5' : 'h-3 w-3'} />

        </button>
      </div>

      {/* Line 2: what is running it: the model, then how full the context
          window is. Where the model comes from is subtext on the next line. */}
      {showMetadata && <>
      <div className="mt-0.5 flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
        <Fact
          grow
          tone={isChat ? 'var(--accent-2)' : 'var(--success)'}
          icon={isChat ? undefined : <TerminalIcon className="h-2.5 w-2.5 shrink-0" />}
          title={`${provider ? `${provider.label} / ` : ''}${session?.modelId ?? model}`}
        >
          {model}
        </Fact>
        {terminal && !terminal.running && (
          <Fact tone="var(--danger)" title="This shell has exited">exited</Fact>
        )}
        {compacting && (
          <span
            className="status-compacting inline-grid shrink-0 place-items-center"
            style={{ color: 'var(--info)' }}
            title="Compacting this chat's context"
            role="img"
            aria-label="Compacting context"
          >
            <CompactIcon className="h-2.5 w-2.5" />
          </span>
        )}
        {isChat && ctxUsed > 0 && (
          <Fact
            tone={fillTone(ctxPct)}
            title={`Context window: about ${ctxUsed.toLocaleString()} of ${ctxWindow.toLocaleString()} tokens (${ctxPct < 1 ? '<1' : Math.round(ctxPct)}%)`}
          >
            {compactTokens(ctxUsed)}/{compactTokens(ctxWindow)}
          </Fact>
        )}
      </div>

      {showProvider && provider && (
        <div className="truncate pl-3 text-[10px] leading-[13px] text-ink-faint" data-card-provider>
          {isLocalProvider(provider.kind) ? 'Local' : provider.label}
        </div>
      )}

      {/* Line 3: its git position, then the PRs it made. The project is the
          group heading the card sits under, so the card does not repeat it. */}
      {(git || prs.length > 0) && (
        <div className="flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
          {git ? (
            <Fact
              shrink
              tone="var(--accent)"
              icon={
                git.worktree ? (
                  <WorktreeIcon className="h-2.5 w-2.5 shrink-0" />
                ) : (
                  <BranchIcon className="h-2.5 w-2.5 shrink-0" />
                )
              }
              title={[
                git.branch ? `On branch ${git.branch}` : `Detached at ${git.head}`,
                git.ahead || git.behind ? `${git.ahead} ahead, ${git.behind} behind upstream` : '',
                git.worktree ? `Linked git worktree: ${git.worktree.path}` : '',
              ].filter(Boolean).join('\n')}
            >
              {git.branch ?? git.head ?? 'detached'}
            </Fact>
          ) : null}
          {(git?.ahead ?? 0) > 0 || (git?.behind ?? 0) > 0 ? (
            <Fact tone="var(--info)" title={`${git!.ahead} ahead of, ${git!.behind} behind, the upstream branch`}>
              {git!.ahead > 0 ? `↑${git!.ahead}` : ''}
              {git!.behind > 0 ? `↓${git!.behind}` : ''}
            </Fact>
          ) : null}
          {prs.length > 0 && (
            <>
              {git && <span aria-hidden className="mx-0.5 h-2.5 w-px shrink-0 bg-line" />}
              <SessionPrLinks prs={prs} />
            </>
          )}
        </div>
      )}

      {/* Line 4: what it has spun up. Only when there is something to say: a
          card for a plain one-window chat should not carry an empty row. */}
      {(subAgentCount > 0 || windows > 1) && (
        <div className="flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
          {subAgentCount > 0 && (
            <Fact
              tone="var(--accent-2)"
              icon={<RobotIcon className="h-2.5 w-2.5 shrink-0" />}
              title={`${subAgentCount} sub-agent${subAgentCount === 1 ? '' : 's'} spawned by this chat`}
            >
              {subAgentCount} sub-agent{subAgentCount === 1 ? '' : 's'}
            </Fact>
          )}
          {windows > 1 && <span className="shrink-0">{windows} windows</span>}
        </div>
      )}
      </>}
    </div>
  );
}

type CardProps = React.ComponentProps<typeof WorkspaceCardImpl>;

/**
 * Memoized, so switching workspaces repaints the two cards whose state changed
 * rather than the whole column. The handlers are left out of the comparison:
 * the sidebar passes fresh closures every render, and each one only closes over
 * this card's workspace id and store actions, which are compared (or stable).
 */
export const WorkspaceCard = memo(WorkspaceCardImpl, (a: CardProps, b: CardProps) => {
  for (const key of Object.keys(b) as Array<keyof CardProps>) {
    if (key === 'onOpen' || key === 'onClose') continue;
    if (a[key] !== b[key]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
});
