import { ContextMenu, ContextAction } from './ContextMenu.js';
import { measuredUsageCost } from './ChatPane.cost.js';
import { CopyIcon } from '../icons.js';
import { needsProviderSetup } from './providers/providerSetup.js';
import { SetupIllustration } from './providers/ProviderChoices.js';
import { revealEditorCaret } from './agent-console/editorCaret.js';
import React, { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DictationButton } from './DictationButton.js';
import { decideApproval, type ApprovalScope } from './agent-console/approval-decision.js';
import type { AgentEvent, AskAnswer, AskRequest, AutoQuality, Session, ContextBundle, IndexedFile, ModelInfo, ProviderConfig, SkillDef, PrInfo, QueuePayload, QueuedPrompt } from '@nekko-agent/shared';
import { archiveDaysLeft, DEFAULT_IMAGE_CHAT_PARAMS, pickAutoModel, AUTO_MODEL_ID, matchSkills, estimateTokens, estimateTranscriptTokens, modelSupportsThinking, getSessionWorkspaceIds, extractPrUrls, collectSessionPrUrls, detectSessionWorkspace, decodeRate, accumulateDecodeMs, hasResumableProgress, isLocalProvider, resolveModelAvailability, estimateCostUSD, getModelPrice, shortLiveStatus, pickAcrossProviders, limitsKeyFor, queueItemPayload, queueItemText, planProgress } from '@nekko-agent/shared';
import type { AutoProviderPick, ProviderPool } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { useGitStatus } from '../useGitStatus.js';
import { clearLiveRun, getLiveRun, takeFinishedRun, useLiveRun, type LiveRun } from '../liveRuns.js';
import { getCachedSession, loadSession, putCachedSession } from '../sessionCache.js';
import { usePaneVisible } from '../paneVisibility.js';
import { afterPaint } from '../afterPaint.js';
import { chatWelcomeState } from './agent-console/chatWelcome.js';
import { useAllProviderLimits, useProviderLimits } from '../useLimits.js';
import { clearDraft, loadDraft, saveDraft } from '../composerDrafts.js';
import { indentListSelection } from '../composerLists.js';
import { draftAfterSkillSelection } from '../composerSkills.js';
import {
  ActivityGroup, ApprovalBar, AutoQualityMenu, MessageBubble, ModelPicker,
  ReplyStatus, useElementWidth,
} from './agent-console/index.js';
import type { PendingApproval } from './agent-console/index.js';
import { LiveTurn, producedTokens, useProducedTokens } from './agent-console/LiveTurn.js';
import { liveTokenRate } from './agent-console/liveTokenRate.js';
import { ImageModeControls } from './agent-console/ImageModeControls.js';
import { ImageLiveTurn } from './agent-console/ImageLiveTurn.js';
import { VirtualTranscript, type VirtualTranscriptHandle } from './agent-console/VirtualTranscript.js';
import { MarkdownEditor, type MarkdownEditorElement } from './agent-console/MarkdownEditor.js';
import { MarkdownSandbox } from './Markdown.js';
import { CompactionSummary } from './agent-console/CompactionSummary.js';
import { promptHistory, recallPrompt, type HistoryCursor } from './agent-console/promptHistory.js';
import { PERSISTED_INTERRUPTION, shouldShowPersistedInterruption, describeInterruption, suggestedReplyClassName } from './agent-console/interruption.js';

import { estimateRowHeight, toTranscriptRows, type TranscriptRow } from './agent-console/transcript.js';
import { ContextGauge, EffortSlider } from './ChatMetrics.js';
import { PlanRail, appendPlanChangeRequest } from './PlanRail.js';
import { TurnStatsLine } from './agent-console/TurnStatsLine.js';
import { ComposerQuestion } from './ComposerQuestion.js';
import { QuestionCard } from './QuestionCard.js';
import { useWallLogs } from '../wallLogs.js';
import { StatusIcon, type AgentStatus } from './WorkspaceCard.js';
import { UsageLimitsChip } from './UsageLimitsChip.js';
import { PaneActions, PaneMetadata, useInPaneFrame } from './PaneFrame.js';
import { ContextWarning } from './ContextWarning.js';
import { ChatControls, InternetToggle, McpMenu, MODE_LABEL, ToolsMenu } from './ChatControls.js';
import { useElementCompact } from './agent-console/useElementWidth.js';
import { PromptAnalyzer } from './PromptAnalyzer.js';
import { ScheduleTaskModal } from './ScheduleTaskModal.js';
import { PrCard, PrActionDock } from './PrCard.js';
import { NekkoAvatar } from './Mascot.js';
import { Modal } from './primitives/index.js';
import { WorktreeChip } from './WorktreeChip.js';
import { FolderPicker } from './FolderPicker.js';
import { AgentCompanionButtons } from './AgentCompanionButtons.js';
import { addFolderToChat, shouldAutoFile } from '../sessionFolders.js';
import { PanelIcon, DownloadIcon, PlusIcon, CloseIcon, BoltIcon, ThoughtIcon, ListIcon, TerminalIcon, WorktreeIcon, CheckIcon, TrashIcon, UndoIcon, QuestionIcon } from '../icons.js';

const NO_PRS: PrInfo[] = []; // stable empty ref so the store selector doesn't churn

/**
 * How long the store's copy of the draft (read by the Context Inspector) trails
 * the composer. Mirroring every keystroke re-rendered everything subscribed to
 * the store while you typed; a short trailing debounce keeps the inspector's
 * count current without that.
 */
const DRAFT_MIRROR_MS = 150;

function queuedPayloadFor(text: string, images: string[], skill: SkillDef | null): QueuePayload | string {
  const trimmed = text.trim();
  return images.length || skill
    ? { text: [skill ? skill.template.trimEnd() : '', trimmed].filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}), ...(skill ? { skill: { name: skill.name, input: trimmed } } : {}) }
    : trimmed;
}

function queuedTitle(item: QueuedPrompt): string {
  const payload = queueItemPayload(item);
  const bits = [payload.text || '(no text)'];
  if (payload.skill) bits.push(`/${payload.skill.name}`);
  if (payload.images?.length) bits.push(`${payload.images.length} image${payload.images.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/**
 * How often a running turn re-reads its context bundle. Each completed step is
 * checkpointed to disk, so a preview between steps is accurate; the throttle
 * keeps a tool-heavy turn from asking on every single result.
 */
const CTX_REFRESH_MS = 1_500;

/**
 * Pane widths the layout keys off, measured on the pane itself.
 *
 * The plan rail is on by default; it only gives way when the window is about
 * as narrow as two rails side by side (`PLAN_RAIL_MIN_PANE`), where it would
 * leave the conversation no more room than itself. `NARROW_PANE` is where the
 * 75% column stops helping and the text should just use the pane.
 */
const PLAN_RAIL_WIDTH = 280;
const PLAN_RAIL_MIN_PANE = PLAN_RAIL_WIDTH * 2;
const NARROW_PANE = 620;

/**
 * The composer's height when the user has dragged it, remembered across chats.
 * Unset means "grow with what's typed", which is where every composer starts.
 */
const COMPOSER_H_KEY = 'nekko.composer.height';
const COMPOSER_MIN_H = 64;
/** The conversation keeps at least this much of the pane, however tall the composer. */
const TRANSCRIPT_MIN_H = 160;

function readComposerHeight(): number | null {
  try {
    const n = Number(window.localStorage.getItem(COMPOSER_H_KEY));
    return Number.isFinite(n) && n >= COMPOSER_MIN_H ? n : null;
  } catch {
    return null;
  }
}


function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Turn a chat image into a Blob. Chat images are data URLs, and the renderer's
 * CSP has no `data:` in connect-src, so `fetch()` on one fails ("Failed to
 * fetch") — decode it by hand instead, and keep fetch only for real URLs.
 */
async function imageBlob(src: string): Promise<Blob> {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(src);
  if (!match) return fetch(src).then((r) => r.blob());
  const type = match[1] || 'image/png';
  if (!match[2]) return new Blob([decodeURIComponent(match[3])], { type });
  const binary = atob(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Re-encode an image as PNG, the only format Chromium will put on the
 *  clipboard. Draws straight from the source URL, which already renders in the
 *  page, so no extra object URL is needed. */
function toPngBlob(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Could not encode the image.'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not read the image.'));
    img.src = src;
  });
}

/** Put a chat image on the system clipboard (as PNG, whatever it arrived as). */
async function copyImageToClipboard(src: string): Promise<void> {
  const blob = await imageBlob(src);
  const png = blob.type === 'image/png' ? blob : await toPngBlob(src);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** Save a chat image to disk, keeping its original format. Goes through a blob
 *  URL rather than the data URL, which Chromium won't always download. */
async function downloadImage(src: string): Promise<void> {
  const blob = await imageBlob(src);
  const ext = (/^image\/([a-z0-9.+-]+)/i.exec(blob.type)?.[1] ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nekko-agent-image.${ext === 'jpeg' ? 'jpg' : ext || 'png'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Right-click menu for a chat image: copy it to the clipboard, or save it. A
 * webview's native menu isn't available here, so this is the app's own, placed
 * at the pointer and flipped when it would run off the edge.
 */
function ImageMenu({ x, y, src, onClose }: { x: number; y: number; src: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Close on a press *outside* the menu, tested against the element rather
    // than by stopping propagation: this menu is portalled to `body`, so a press
    // inside it reaches the document listener anyway, and closing on mousedown
    // would unmount the item before its click could fire.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape dismisses the top layer only. Captured on `window`, one step
      // ahead of the lightbox's own document-capture handler, so stopping
      // propagation here actually keeps the lightbox open.
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const WIDTH = 176;
  const HEIGHT = 76;
  const left = Math.min(x, Math.max(8, window.innerWidth - WIDTH - 8));
  const top = Math.min(y, Math.max(8, window.innerHeight - HEIGHT - 8));

  const copy = async () => {
    onClose();
    try {
      await copyImageToClipboard(src);
      useStore.getState().pushToast('success', 'Image copied to the clipboard.');
    } catch {
      useStore.getState().pushToast('error', "Couldn't copy that image.");
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="card fixed w-44 p-1.5 shadow-lg"
      style={{ left, top, zIndex: 60 }}
      role="menu"
      aria-label="Image actions"
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        role="menuitem"
        className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
        onClick={copy}
      >
        Copy image
      </button>
      <button
        role="menuitem"
        className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
        onClick={async () => {
          onClose();
          try {
            await downloadImage(src);
          } catch {
            useStore.getState().pushToast('error', "Couldn't save that image.");
          }
        }}
      >
        Save image…
      </button>
    </div>,
    document.body,
  );
}

/** The provider and model a chat opens on: its own, or the app's defaults. */
function initialBrain(s: Session | null | undefined): { providerId: string | null; modelId: string | null } {
  const st = useStore.getState();
  return {
    providerId: s?.providerId ?? st.activeProviderId ?? st.providers[0]?.id ?? null,
    modelId: s?.autoModel ? AUTO_MODEL_ID : (s?.modelId ?? st.activeModelId ?? null),
  };
}

/**
 * One chat conversation, fully self-contained so several can run side by side in
 * the workbench. Provider/model are chosen per-pane (independent agents); the
 * pane subscribes to agent events filtered by its own sessionId.
 */
/**
 * The chat's own chrome, wherever it happens to be.
 *
 * Inside a workspace window the frame already draws a title strip with this
 * chat's name in it, so the actions move into that strip and no second bar is
 * drawn: two bars stacked on each other, both saying the same title, was the
 * shape this replaces. Anywhere else there is no strip to join, so the chat
 * draws the header it always did.
 */
function ChatHeader({
  title,
  subAgent,
  metadata,
  children,
  inWall = false,
}: {
  title: string;
  subAgent: boolean;
  metadata?: React.ReactNode;
  children: React.ReactNode;
  /**
   * A window on the Agents wall: its strip always names the chat, so this
   * never draws a second title row, even if the frame's slot context is not
   * found (a hot-reloaded frame module gets a new context object).
   */
  inWall?: boolean;
}) {
  const framed = useInPaneFrame();
  if (framed || inWall) {
    return (
      <>
        <PaneMetadata>{metadata}</PaneMetadata>
        <PaneActions>
          {subAgent && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
          {children}
        </PaneActions>
      </>
    );
  }
  return (
    <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {/* The "/" names the boundary between what this is (the title) and
            where it lives (the project and git context), so it leads that
            context rather than trailing it. */}
        {metadata && <span aria-hidden="true" className="text-ink-faint opacity-40">/</span>}
        {metadata}
        {subAgent && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </header>
  );
}

/**
 * One transcript row: a message and the PR cards it is first to mention, a run
 * of working steps, or the trailing PR cards. Memoized, so a row re-renders
 * only when its own data does.
 */
const TranscriptRowView = memo(function TranscriptRowView({
  row, streaming, readOnly, prByUrl, sessionId, basePath, onEditResend, onCopyToComposer, onSplit, onImageClick, onImageContextMenu,
}: {
  row: TranscriptRow;
  basePath?: string;
  streaming: boolean;
  /** An archived chat: nothing on a row may change the conversation. */
  readOnly: boolean;
  prByUrl: Map<string, PrInfo>;
  sessionId: string;
  onEditResend: (id: string, text: string) => void;
  onCopyToComposer: (id: string) => void;
  onSplit: (id: string) => void;
  onImageClick: (src: string) => void;
  onImageContextMenu: (e: React.MouseEvent, src: string) => void;
}) {
  if (row.kind === 'activity') return <ActivityGroup items={row.items} />;
  if (row.kind === 'compaction') return <CompactionSummary message={row.message} latest={row.latest} />;
  if (row.kind === 'stats') return <div className="msg-ai"><TurnStatsLine stats={row.stats} /></div>;
  if (row.kind === 'prs') {
    // Historical milestones stay anchored to their original transcript positions.
    return <>{row.urls.map((u) => <PrCard key={`${row.event}_${u}`} url={u} info={prByUrl.get(u)} event={row.event} />)}</>;
  }
  const persisted = row.message.id !== 'tmp' && row.message.id !== 'live';
  const editable = !readOnly && !streaming && row.message.role === 'user' && persisted;
  return (
    <>
      <MessageBubble
        message={row.message}
        basePath={basePath}
        onResend={editable ? onEditResend : undefined}
        onReset={editable ? onEditResend : undefined}
        onCopyToComposer={!readOnly && persisted ? onCopyToComposer : undefined}
        onSplit={editable ? onSplit : undefined}
        onImageClick={onImageClick}
        onImageContextMenu={onImageContextMenu}
        chronological
      />
      {/* A PR card right after the message that first names it. */}
      {row.prUrls.map((u) => <PrCard key={u} url={u} info={prByUrl.get(u)} event="created" />)}
    </>
  );
});

/**
 * Where a turn's live numbers stand against the last context bundle: what it
 * has produced that the bundle does not include yet, and what it has output
 * since the provider last reported usage. Read per frame by the small
 * components below, so the pane around them does not re-render per token.
 */
interface LiveMarks {
  /** Context tokens the current bundle already accounts for. */
  ctxMark: number;
  /** Context tokens the turn produced, kept once it ends until the bundle catches up. */
  ctxTail: number;
  /** Output tokens already priced by a usage event. */
  outMark: number;
}

function useLiveContextTokens(sessionId: string, marks: LiveMarks): number {
  const produced = useProducedTokens(sessionId);
  const running = !!getLiveRun(sessionId);
  return Math.max(0, (running ? produced.context : marks.ctxTail) - marks.ctxMark);
}

/** The composer's context gauge, moving with the reply as it streams. */
const LiveContextGauge = memo(function LiveContextGauge({
  sessionId, marks, ...gauge
}: Omit<React.ComponentProps<typeof ContextGauge>, 'liveTokens'> & { sessionId: string; marks: LiveMarks }) {
  return <ContextGauge {...gauge} liveTokens={useLiveContextTokens(sessionId, marks)} />;
});

/** The "running out of room" warning, counting the reply as it streams. */
const LiveContextWarning = memo(function LiveContextWarning({
  sessionId, marks, baseUsed, ...warning
}: Omit<React.ComponentProps<typeof ContextWarning>, 'used' | 'sessionId'> & {
  sessionId: string; marks: LiveMarks; baseUsed: number;
}) {
  const live = useLiveContextTokens(sessionId, marks);
  return <ContextWarning sessionId={sessionId} {...warning} used={baseUsed + live} />;
});

/** The usage chip, pricing what has streamed since the last usage report. */
const LiveUsageChip = memo(function LiveUsageChip({
  sessionId, marks, measured, pendingIn, model, ...chip
}: Omit<React.ComponentProps<typeof UsageLimitsChip>, 'turnCost'> & {
  sessionId: string; marks: LiveMarks; measured: number; pendingIn: number; model: string | null;
}) {
  const produced = useProducedTokens(sessionId);
  const turnCost = measured + estimateCostUSD(model ?? undefined, pendingIn, Math.max(0, produced.output - marks.outMark));
  return <UsageLimitsChip {...chip} turnCost={turnCost} />;
});

/**
 * The line under the conversation: what the reply is doing, read off the
 * app-wide fold (so it says the same as the chat's Command Center card), and
 * how long it has been at it.
 */
const LiveReplyStatus = memo(function LiveReplyStatus({
  sessionId, startedAt, ...status
}: Omit<React.ComponentProps<typeof ReplyStatus>, 'status' | 'elapsed'> & { sessionId: string; startedAt: number }) {
  const run = useLiveRun(sessionId, !usePaneVisible());
  const [elapsed, setElapsed] = useState(0);
  const [nextWakeAt, setNextWakeAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let live = true;
    const refresh = () => { void window.nekko.nextAgentWatchAt(sessionId).then((wake) => {
      if (live) { setNextWakeAt(wake); setNow(Date.now()); }
    }).catch(() => { if (live) setNextWakeAt(null); }); };
    refresh();
    const interval = setInterval(refresh, 15_000);
    const off = window.nekko.onAgentEvent((e) => {
      if (e.sessionId === sessionId && (e.type === 'tool_result' || e.type === 'done' || e.type === 'error')) refresh();
    });
    return () => { live = false; clearInterval(interval); off(); };
  }, [sessionId]);
  useEffect(() => {
    if (!status.streaming) return;
    const tick = () => { if (startedAt) setElapsed(Math.round((Date.now() - startedAt) / 1000)); };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [status.streaming, startedAt]);
  const liveRate = status.streaming ? liveTokenRate(run) : null;
  const label = status.streaming ? shortLiveStatus(run?.activity) || 'Working' : '';
  return <ReplyStatus {...status} tps={liveRate?.rate ?? status.tps} estimatedRate={!!liveRate} status={label} elapsed={status.streaming ? elapsed : 0} nextWakeAt={nextWakeAt} now={now} />;
});

/**
 * Focus the composer when a chat opens so you can start typing straight away,
 * caret after any restored draft. Once per chat, and again whenever a pane
 * kept mounted behind the scenes is shown, so switching back to a chat lands
 * in its composer as it always did. Never steals focus from something else
 * you're already typing in. `ready` is a dependency because the textarea is
 * disabled until providers have loaded.
 *
 * Its own component so the pane showing and hiding re-renders this, not the
 * chat; and done after the frame, because focus forces a layout, and paying for
 * it inside the switch would hold back the frame that shows the chat.
 */
function ComposerFocus({ target, sessionId, ready }: { target: React.RefObject<MarkdownEditorElement | null>; sessionId: string; ready: number }) {
  const visible = usePaneVisible();
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      focusedFor.current = null;
      return;
    }
    if (focusedFor.current === sessionId) return;
    return afterPaint(() => {
      const el = target.current;
      if (!el || !el.isContentEditable) return;
      const active = document.activeElement;
      // A composer in a pane that was just hidden may still hold focus for a
      // moment; it is not someone typing.
      const typingElsewhere =
        active instanceof HTMLElement &&
        active !== el &&
        active.checkVisibility?.() !== false &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (typingElsewhere) return;
      focusedFor.current = sessionId;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [visible, sessionId, ready, target]);
  return null;
}

function ChatPaneImpl({ sessionId, onRunningChange, readOnly = false, commandCenter = false, surface = 'full', status, selected, header }: {
  sessionId: string;
  /** What the agent is doing (rocket, Zz, ?), drawn in the far bottom-right corner of the window's footer. */
  // A value, not an element: ChatPane is memoized, and a fresh <StatusIcon/>
  // from the wall on every render made every window re-render on every switch.
  status?: AgentStatus | 'idle';
  commandCenter?: boolean;
  /** On the Agents wall: whether this window is the selected one. Undefined off the wall. */
  selected?: boolean;
  /**
   * The wall composer's own top row (which agent it speaks for, its status and
   * dock controls). Given, it replaces the controls strip: mode and incognito
   * move to the bottom bar beside +, Automate to this row's right end.
   */
  header?: React.ReactNode;
  /**
   * Which part of the chat this instance shows. A window on the Command
   * Center wall shows the `transcript` alone; the wall's one composer shows
   * the `composer` alone for the selected chat; everywhere else a pane is the
   * `full` chat. Two instances of the same chat may be on screen at once (a
   * wall window and the composer); both read the same live run and cache.
   */
  surface?: 'full' | 'transcript' | 'composer';
  onRunningChange?: (running: boolean) => void;
  /**
   * An archived chat, opened to be read: the transcript renders as usual, but
   * nothing can be sent, edited or split, and the composer is replaced by the
   * two things that make sense for an archived chat, restore it or delete it.
   */
  readOnly?: boolean;
}) {
  const { providers, settings, setMascotMood, refreshSessions } = useStore(
    useShallow((s) => ({
      providers: s.providers,
      settings: s.settings,
      setMascotMood: s.setMascotMood,
      refreshSessions: s.refreshSessions,
    })),
  );

  // Painted straight from the session cache when this chat was open recently;
  // the host copy is fetched regardless and replaces it (stale-while-revalidate).
  const [session, setSession] = useState<Session | null>(() => getCachedSession(sessionId) ?? null);
  // Seed the composer from whatever was parked for this chat, so an unsent
  // message survives a tab switch or a restart.
  const [draft, setDraft] = useState(() => loadDraft(sessionId)?.text ?? '');
  // What the draft implies (the analyzer, Auto's pick, the gauge's draft
  // count) renders from this, one step behind the keystroke, so
  // a keypress paints the textarea before any of that work runs.
  const deferredDraft = useDeferredValue(draft);
  const [streaming, setStreaming] = useState(false);
  // Mirrors for the long-lived agent-event listener, so a token does not set
  // state that is already set.
  const streamingRef = useRef(false);
  const thinkingRef = useRef(false);
  /**
   * The reply that just finished, kept on screen until its persisted copy is in
   * `session`, then cleared in the same commit, so the end of a reply never
   * flashes the answer out and back in. While a turn runs the live reply comes
   * from liveRuns (see LiveTurn); this pane holds no copy of the stream.
   */
  const [held, setHeld] = useState<LiveRun | null>(null);
  const heldRef = useRef<LiveRun | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  /**
   * The question the agent stopped to ask, when it has. Seeded from the host on
   * mount as well as from the event, so a question asked while this pane was
   * closed is still there when it opens.
   */
  const [question, setQuestion] = useState<AskRequest | null>(null);
  const [ctx, setCtx] = useState<ContextBundle | null>(null);
  // Tokens this turn has produced that the last context bundle doesn't include
  // yet. Everything the agent writes (its reply, its tool calls, their results)
  // is replayed in the next request's prompt, so the window fills as the turn
  // runs; without this the gauge sat still for minutes and jumped at the end.
  // The produced count itself is read per frame from the live run (see
  // LiveMarks); these are the marks it is measured against.
  const [marks, setMarks] = useState<LiveMarks>({ ctxMark: 0, ctxTail: 0, outMark: 0 });
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const lastCtxRefresh = useRef(0);
  const [tps, setTps] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [atFiles, setAtFiles] = useState<IndexedFile[]>([]);
  const [cost, setCost] = useState(0);
  const [avoidedCosts, setAvoidedCosts] = useState<import('@nekko-agent/shared').AvoidedCosts>();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // The + menu's Skill row expands its skills as a side flyout on hover (no
  // click needed); a short close-delay lets the pointer cross the seam.
  const [skillsHover, setSkillsHover] = useState(false);
  const skillsFlyTimer = useRef<number | null>(null);
  const [pendingImages, setPendingImages] = useState<string[]>(() => loadDraft(sessionId)?.images ?? []);
  // The context panel toggle lives in the store so the ⌘\ shortcut and the
  // command palette's "Toggle context panel" act on this pane too.
  const ctxOpen = useStore((s) => s.contextPanelOpen);
  // The plan/sub-agent rail beside the transcript (see PlanRail). Whether there
  // is room for it depends on this pane, not on the window: the workbench splits,
  // so a viewport breakpoint would keep the rail open in a pane squeezed to a
  // third of a wide screen and drop it from a narrow window that has nothing
  // else on it.
  const planRailWanted = useStore((s) => s.planRailOpen);
  const paneRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(paneRef, sessionId);
  const planRailOpen = planRailWanted && paneWidth >= PLAN_RAIL_MIN_PANE;
  const planSteps = useMemo(() => { const p = planProgress(session?.agentPlan); return { done: p.done + p.skipped, total: p.total }; }, [session?.agentPlan]);
  const wideEnoughForRail = paneWidth >= PLAN_RAIL_MIN_PANE;
  // A small window (a cell on the Command Center wall, a sliver of a split)
  // folds the two control rows into one summary chip, so the transcript keeps
  // the room; the chip opens them again on demand.
  const compact = useElementCompact(paneRef) && surface !== 'composer';
  const [controlsOpen, setControlsOpen] = useState(false);
  const showControls = !compact || controlsOpen;
  // The armed skill lives in the store (per session) so the Context Inspector on
  // the right can show it and count its tokens while it's active.
  const activeSkill = useStore((s) => s.activeSkillBySession[sessionId] ?? null);
  const setActiveSkill = (skill: SkillDef | null) => useStore.getState().setActiveSkill(sessionId, skill);
  // PRs referenced in this chat (for the header badge + inline cards).
  const prs = useStore((s) => s.prsBySession[sessionId] ?? NO_PRS);
  // Where this chat is working in git: the worktree, the branch, and the PR
  // that branch is going into. The same read the sidebar card makes (the host
  // caches it), so the header and the card never disagree.
  const git = useGitStatus(session ? `session:${session.id}` : undefined, session?.gitIsolation);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Whether this agent's command log drawer is out on the Agents wall.
  const logsOpen = useWallLogs((s) => s.sessionId === sessionId && !s.closing);
  // Right-click menu for a chat image (copy / save), placed at the pointer.
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [chatMenu, setChatMenu] = useState<{ x: number; y: number } | null>(null);
  const [doneSummary, setDoneSummary] = useState<string | null>(null);
  // What the model thinks the user will say next: the composer's ghost text.
  // Pinned to the reply it was written for (forId) so
  // a newer turn can't inherit stale suggestions.
  const [suggestions, setSuggestions] = useState<{ forId: string; options: string[]; next: string | null } | null>(null);
  // A failed reply stays in the transcript with a retry, instead of vanishing
  // with the toast.
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  // Seeded from the cached transcript when there is one, so a warm chat opens
  // with its model already chosen instead of settling a render later.
  // (A chat that is not cached waits for its own record, as it always has.)
  const [providerId, setProviderId] = useState<string | null>(() => {
    const cached = getCachedSession(sessionId);
    return cached ? initialBrain(cached).providerId : null;
  });
  const [modelId, setModelId] = useState<string | null>(() => {
    const cached = getCachedSession(sessionId);
    return cached ? initialBrain(cached).modelId : null;
  });
  useEffect(() => {
    const changed = (event: Event) => {
      const { id, session: fresh } = (event as CustomEvent<{id: string; session: Session}>).detail;
      if (id !== sessionId) return;
      putCachedSession(fresh); setSession(fresh);
      setProviderId(fresh.providerId ?? null); setModelId(fresh.autoModel ? AUTO_MODEL_ID : fresh.modelId ?? null);
    };
    window.addEventListener('nekko-session-brain', changed);
    return () => window.removeEventListener('nekko-session-brain', changed);
  }, [sessionId]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Whether this pane's model list has come back yet, so the "pick a model"
  // nudge waits for the truth instead of flashing during the fetch.
  const [modelsLoaded, setModelsLoaded] = useState(false);
  // The model menu's open state lives here so the nudge below the transcript can
  // open the very picker it points at.
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [contextChangeNotice, setContextChangeNotice] = useState(false);
  const contextNoticeTrigger = useRef<HTMLElement | null>(null);
  const closeContextNotice = () => {
    setContextChangeNotice(false);
    requestAnimationFrame(() => contextNoticeTrigger.current?.focus());
  };
  // The "choose a model" tooltip is a one-shot nudge: opening the picker means
  // the point landed, so it retires for this chat instead of hanging around.
  const [modelHintDone, setModelHintDone] = useState(false);
  // The chat's saved model, when its provider's list came back without it (a
  // signed-out subscription, a local server with nothing loaded). Kept so the
  // chip can name what went missing instead of quietly reading "Choose a model".
  const [unavailableModel, setUnavailableModel] = useState<string | null>(null);
  const recentModels = useStore((s) => s.sessions)
    .filter((s) => s.modelId && s.providerId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => `${s.providerId}::${s.modelId}`)
    .filter((key, i, all) => all.indexOf(key) === i);
  // Live telemetry for the subtext under the chat: output tokens, elapsed
  // seconds, and a summary of the last completed reply.
  const [turnOut, setTurnOut] = useState(0);
  /**
   * What the reply now running has cost so far, at published list prices,
   * accumulated per step as the usage events arrive rather than read back from
   * the usage log after the turn ends. A long agentic turn is exactly when
   * someone wants to see the number moving. `turnCostMeasured` is what usage
   * events have reported; the chip adds an estimate for what has streamed since
   * (see LiveUsageChip).
   */
  const [turnCostMeasured, setTurnCostMeasured] = useState(0);
  /**
   * Prompt tokens of a step that has not reported usage yet, priced from the
   * context gauge's own count the instant the turn starts, so the figure is
   * never a zero that sits there while a large prompt is being processed.
   */
  const [pendingIn, setPendingIn] = useState(0);
  const [lastTurn, setLastTurn] = useState<{ out: number; tps: number; secs: number } | null>(null);
  // Keyboard state for the slash/@ menus: the highlighted row, and whether the
  // user dismissed the menu with Escape (typing re-opens it).
  const [menuSel, setMenuSel] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  // "Jump to latest" pill: shown when new content streams in while the reader
  // has scrolled up.
  const [showJump, setShowJump] = useState(false);
  const transcriptRef = useRef<VirtualTranscriptHandle>(null);
  const composerRef = useRef<MarkdownEditorElement>(null);
  // A dragged composer height, or null to size to the draft. See COMPOSER_H_KEY.
  const [composerH, setComposerH] = useState<number | null>(readComposerHeight);
  const composerSectionRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const turnStart = useRef(0);
  // Milliseconds the model actually spent generating this turn's tokens, summed
  // over the reply's steps. Separate from `turnStart`, which is wall clock and
  // also covers prompt processing, tool runs, and approval waits, so dividing
  // tokens by it under-reports throughput (badly, on a tool-heavy turn).
  const turnDecodeMsRef = useRef(0);
  const turnOutRef = useRef(0);
  /**
   * Cost the provider has actually reported for this turn, summed per step.
   *
   * Kept apart from the estimate below because the two have different standing:
   * this is measured, that is a guess made while we wait for the measurement.
   */
  const turnCostRef = useRef(0);
  /**
   * The model this turn is actually running on, for pricing its usage events.
   * A ref because the agent-event listener is long-lived, and the model can be
   * resolved per send (Auto mode), so the state variable would price a turn at
   * whatever the picker shows now rather than at what ran.
   */
  const modelForCostRef = useRef<string | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) closeAttachMenu();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Track how many files the agent changed this chat (for the Changes button).
  useEffect(() => {
    let live = true;
    const load = () => window.nekko.listChanges(sessionId).then((c) => { if (live) setChangeCount(c.length); }).catch(() => {});
    const cancel = afterPaint(load);
    const off = window.nekko.onChangesUpdated((e) => { if (e.sessionId === sessionId) load(); });
    return () => { live = false; cancel(); off(); };
  }, [sessionId]);

  useEffect(() => onRunningChange?.(streaming), [streaming, onRunningChange]);

  /**
   * Pull a fresh context bundle and settle the live estimate against it.
   *
   * The agent loop appends each assistant message and tool result to the
   * session as it goes, so a mid-turn preview is real, not stale. Whatever
   * streams while the request is out stays counted (the bundle can't know about
   * it yet), which is why the mark is what had been produced when the request
   * went out rather than a reset: tokens that arrived during the round trip
   * would otherwise be dropped.
   */
  const refreshCtx = () => {
    const run = getLiveRun(sessionId);
    const mark = run ? producedTokens(run).context : marksRef.current.ctxTail;
    lastCtxRefresh.current = Date.now();
    window.nekko.previewContext(sessionId, [])
      .then((b) => {
        setCtx(b);
        setMarks((m) => ({ ...m, ctxMark: mark }));
      })
      .catch(() => setCtx(null));
  };

  const refreshCtxRef = useRef(refreshCtx);
  refreshCtxRef.current = refreshCtx;

  /** Refresh at most every CTX_REFRESH_MS, for the per-step mid-turn updates. */
  const refreshCtxThrottled = () => {
    if (Date.now() - lastCtxRefresh.current < CTX_REFRESH_MS) return;
    refreshCtx();
  };

  /** Seed provider/model from the session (or the global defaults). */
  const seedBrain = (s: Session | null) => {
    const brain = initialBrain(s);
    setProviderId(brain.providerId);
    setModelId(brain.modelId);
  };

  // Load the session. A cached copy (if any) is already on screen from the
  // first render; the host's copy replaces it when it arrives.
  useEffect(() => {
    const cached = getCachedSession(sessionId);
    let live = true;
    // After the first paint: the frame (and a cached transcript) goes on
    // screen before any of this is even asked for.
    const cancel = afterPaint(() => {
      loadSession(sessionId).then((s) => {
        if (!live) return;
        setSession(s);
        if (!cached) seedBrain(s);
      }).catch(() => {});
      refreshCtx();
      useStore.getState().refreshSessionPrs(sessionId);
    });
    return () => { live = false; cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Whatever this pane shows is the freshest copy the renderer has, so the
  // cache follows it (optimistic messages included; the next load replaces them).
  useEffect(() => {
    if (session?.id === sessionId) putCachedSession(session);
  }, [session, sessionId]);

  // Models for this pane's provider (independent of other panes). A chat that
  // has never had a model picked is left unset on purpose: the nudge below the
  // transcript asks for a choice rather than guessing one.
  useEffect(() => {
    if (!providerId) { setModels([]); setModelsLoaded(false); setUnavailableModel(null); return; }
    setModelsLoaded(false);
    let live = true;
    const cancel = afterPaint(() => {
      window.nekko.listModels(providerId).then((m) => {
        if (!live) return;
        setModels(m);
        setModelId((cur) => {
          const keep = cur === AUTO_MODEL_ID || (!!cur && m.some((x) => x.id === cur));
          setUnavailableModel(keep ? null : cur);
          return keep ? cur : null;
        });
        setModelsLoaded(true);
      }).catch(() => { if (live) { setModels([]); setModelId((cur) => { if (cur && cur !== AUTO_MODEL_ID) setUnavailableModel(cur); return cur === AUTO_MODEL_ID ? cur : null; }); setModelsLoaded(true); } });
    });
    return () => { live = false; cancel(); };
  }, [providerId]);

  // Per-chat cost at the model's published API prices. Subscription chats are
  // priced too (listCost), so the composer can say what the chat is worth in
  // API terms rather than just "Subscription".
  useEffect(() => afterPaint(() => {
    window.nekko.getUsageSummary().then((u) => {
      const s = u.bySession[sessionId];
      setCost(s ? (s.listCost ?? s.cost ?? 0) : 0);
      setAvoidedCosts(u.bySessionAvoidedCosts?.[sessionId]);
    }).catch(() => { setCost(0); setAvoidedCosts(undefined); });
  }), [sessionId, session?.modelId, session?.messages.length, settings?.localCostBenchmark]);

  // Keep the sidebar's per-workspace context readout fresh while a turn runs.
  // The pane already re-reads its context bundle per step (throttled to
  // CTX_REFRESH_MS); this adds a slow heartbeat so the number also creeps up
  // between steps, and so it settles once at the end of the turn.
  const latestCtxRef = useRef(ctx);
  latestCtxRef.current = ctx;
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => {
      const conversationTokens = latestCtxRef.current?.items.find((i) => i.included && i.source === 'conversation')?.tokens
        ?? estimateTranscriptTokens(latestSessionRef.current?.messages ?? []);
      const produced = producedTokens(getLiveRun(sessionId)).context;
      const live = Math.max(0, produced - marksRef.current.ctxMark);
      useStore.getState().setSessionCtxEstimate(sessionId, conversationTokens + live);
    }, 4_000);
    return () => {
      clearInterval(t);
      useStore.getState().setSessionCtxEstimate(sessionId, null);
    };
  }, [streaming, sessionId]);

  /**
   * Adopt a turn that was already running when this pane mounted.
   *
   * A pane that is not on screen may be unmounted, and a chat that is
   * mid-reply comes back to a fresh pane. The run itself never stopped
   * (liveRuns folds it for the whole app, and LiveTurn renders it from there),
   * so only this pane's own telemetry, the clock and the counts, is read back
   * here rather than waiting for the next event to say a turn is running.
   */
  useEffect(() => {
    const run = getLiveRun(sessionId);
    if (!run) return;
    turnStart.current = run.startedAt;
    turnOutRef.current = run.outputTokens;
    turnDecodeMsRef.current = run.decodeMs;
    setTurnOut(run.outputTokens);
    setTps(decodeRate(run.outputTokens, run.decodeMs));
    if (run.reasoningStartedAt) { thinkingRef.current = true; setThinking(true); }
    streamingRef.current = true;
    setStreaming(true);
    setMascotMood('thinking');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Anything this chat is already blocked on. The events below only reach a
  // mounted pane, so a question asked while you were on the board — or before
  // this pane was opened at all — would otherwise be invisible here.
  useEffect(() => {
    let live = true;
    const cancel = afterPaint(() => {
      window.nekko.pendingInput().then((pending) => {
        if (!live) return;
        const mine = pending[sessionId];
        if (mine?.question) setQuestion(mine.question);
        if (mine?.approval) setApproval({ call: mine.approval.call, reason: mine.approval.reason, severity: mine.approval.severity });
      }).catch(() => {});
    });
    return () => { live = false; cancel(); };
  }, [sessionId]);

  // Agent events for this session only. The streamed text itself is folded by
  // liveRuns and drawn by LiveTurn, once a frame; this listener only moves the
  // pane between states (running, blocked, done) and its per-step numbers, so
  // a token costs it nothing.
  useEffect(() => {
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (e.sessionId !== sessionId) return;
      // A reply may start host-side (a queued follow-up, or a task-driven run):
      // reflect it as streaming even though this pane didn't call send().
      if (e.type === 'text' || e.type === 'reasoning' || e.type === 'tool_call' || e.type === 'image_status') {
        if (!streamingRef.current) {
          streamingRef.current = true;
          setStreaming(true);
          // A turn this pane did not start: nothing it produces is counted yet.
          setMarks({ ctxMark: 0, ctxTail: 0, outMark: 0 });
        }
        if (!turnStart.current) { turnStart.current = Date.now(); setMascotMood('thinking'); }
      }
      switch (e.type) {
        case 'reasoning':
          if (!thinkingRef.current) { thinkingRef.current = true; setThinking(true); }
          break;
        case 'usage': {
          // Accumulate output tokens and decode time across the reply's steps, so
          // the rate is tokens over the time spent generating them: the same
          // figure the runtime reports, rather than tokens over the whole wait.
          turnOutRef.current += e.outputTokens;
          turnDecodeMsRef.current = accumulateDecodeMs(turnDecodeMsRef.current, e.outputTokens, e.outputMs);
          setTurnOut(turnOutRef.current);
          setTps(decodeRate(turnOutRef.current, turnDecodeMsRef.current));
          // Each step is priced as it lands, because the input tokens of a
          // multi-step turn are not one prompt counted once: every step resends
          // the transcript, and that is most of what a long turn costs.
          // Measured numbers for the step that just finished, so the estimate
          // that stood in for it is dropped rather than added to.
          turnCostRef.current += measuredUsageCost(modelForCostRef.current ?? undefined, e);
          setTurnCostMeasured(turnCostRef.current);
          setPendingIn(0);
          setMarks((m) => ({ ...m, outMark: producedTokens(getLiveRun(sessionId)).output }));
          break;
        }
        case 'tool_approval_required':
          setApproval({ call: e.call, reason: e.reason, severity: e.severity });
          setMascotMood('thinking');
          break;
        case 'question':
          setErrorNotice(null);
          setQuestion(e.request);
          setMascotMood('thinking');
          break;
        case 'question_resolved':
          setQuestion((q) => (q?.callId === e.callId ? null : q));
          break;
        case 'tool_result':
          setApproval(null);
          // The step just landed on disk, so the bundle can account for it (and
          // for the tool's output, which the renderer never sees in full).
          refreshCtxThrottled();
          break;
        case 'error':
          if (e.message !== 'Stopped') {
            useStore.getState().pushToast('error', describeInterruption(e.message || 'Something went wrong.', false).reason);
          }
          setErrorNotice(e.message || 'Something went wrong.');
          endTurn();
          break;
        case 'done':
          endTurn();
          refreshCtx();
          void requestSuggestions();
          break;
        case 'session_meta':
          // The session record changed mid-turn — a new agent plan, or a fresh
          // title — so re-read it and refresh the sidebar/boards alongside.
          loadSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
          void refreshSessions();
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, setMascotMood]);

  const finalizingReply = useRef(false);
  const endTurn = () => {
    finalizingReply.current = true;
    streamingRef.current = false;
    setStreaming(false);
    // The turn is over. liveRuns has usually retired the run already (it hears
    // the event first); if this listener got there first it is retired here, so
    // the app-wide live copy never outlives the turn and a pane mounted later
    // does not show the same reply twice.
    const final = takeFinishedRun(sessionId) ?? getLiveRun(sessionId) ?? null;
    clearLiveRun(sessionId);
    takeFinishedRun(sessionId);
    heldRef.current = final;
    setHeld(final);
    // Until the bundle has been re-read, what the turn produced still counts.
    setMarks((m) => ({ ...m, ctxTail: producedTokens(final ?? undefined).context }));

    // Snapshot the reply's telemetry for the idle subtext (refs only, so this is
    // safe inside the long-lived agent-event listener closure).
    const secs = turnStart.current ? Math.round((Date.now() - turnStart.current) / 1000) : 0;
    if (turnOutRef.current > 0) {
      setLastTurn({ out: turnOutRef.current, tps: decodeRate(turnOutRef.current, turnDecodeMsRef.current), secs });
    }
    turnOutRef.current = 0;
    turnDecodeMsRef.current = 0;

    // Build a short completion summary from the tools used in this reply.
    const usedTools = final?.tools ?? [];
    if (usedTools.length > 0) {
      const unique = Array.from(new Set(usedTools.map((t) => t.name)));
      const hasEdit = unique.some((n) => n === 'edit_file' || n === 'write_file');
      const hasRead = unique.some((n) => n === 'read_file' || n === 'list_dir' || n === 'grep' || n === 'glob');
      const hasBash = unique.includes('bash');
      let summary = '';
      if (hasEdit) summary = 'Done updating those files.';
      else if (hasRead) summary = 'Done looking into that.';
      else if (hasBash) summary = 'Done running those commands.';
      else if (final?.text.trim()) summary = 'Done.';
      if (summary) {
        setDoneSummary(summary);
        setTimeout(() => setDoneSummary(null), 4000);
      }
    }

    setMascotMood('idle');
    turnStart.current = 0;

    // Hold the streamed reply on screen until its persisted copy is in state,
    // then clear the held copy in the same commit, so the end of a reply never
    // flashes the answer out and back in.
    loadSession(sessionId).then((s) => {
      finalizingReply.current = false;
      setSession(s);
      if (heldRef.current === final) {
        heldRef.current = null;
        setHeld(null);
      }
    }).catch(() => { finalizingReply.current = false; });
    refreshSessions();
    // A reply may have created or updated a PR (e.g. `gh pr create`).
    useStore.getState().refreshSessionPrs(sessionId);
  };

  /**
   * Ask the model what the user might say next, then pin the answer to the
   * reply it was written for. Nice-to-have traffic: a provider hiccup, a
   * session with nothing to suggest from, or a malformed reply all just mean
   * no placeholder suggestion this turn.
   */
  const requestSuggestions = async () => {
    try {
      const res = await window.nekko.suggestReplies(sessionId);
      if (!res || (res.options.length === 0 && !res.next)) return;
      const fresh = await window.nekko.getSession(sessionId);
      const last = fresh?.messages[fresh.messages.length - 1];
      // A turn that started while the call was in flight (a queued prompt, a
      // send from another pane) makes the suggestions stale; drop them.
      if (!last || last.role !== 'assistant') return;
      setSuggestions({ forId: last.id, options: res.options, next: res.next });
    } catch {
      /* suggestions are nice-to-have */
    }
  };

  // The transcript follows the stream only while the reader is at the bottom
  // (VirtualTranscript owns that); scrolled up, new content offers the jump
  // pill instead of yanking them down on every token.
  const onPinnedChange = useCallback((pinned: boolean) => {
    if (pinned) setShowJump(false);
  }, []);
  const onGrowWhileUnpinned = useCallback(() => setShowJump(true), []);

  const jumpToLatest = () => {
    setShowJump(false);
    transcriptRef.current?.scrollToBottom('smooth');
  };

  // Grow the composer with its content: reset to the two-line minimum, then match
  // the scroll height (CSS max-height caps it and lets it scroll past that).
  // A composer the user has sized keeps that size and scrolls instead.
  useLayoutEffect(() => {
    const el = composerRef.current;
    const pane = paneRef.current;
    const section = composerSectionRef.current;
    if (!el || !pane || !section || surface === 'composer') return;
    // Empty drafts already have their minimum height in CSS. Warm switching
    // should not force layout merely to rediscover that same empty-editor size.
    if (!draft && composerH === null) {
      el.style.height = '';
      el.style.maxHeight = '';
      return;
    }
    // The shared wall composer uses flex sizing in CSS, including its editor.
    // Measuring and rewriting that height forces layout without affecting it.
    const resize = () => {
      const chrome = section.getBoundingClientRect().height - el.getBoundingClientRect().height;
      const limit = Math.max(0, Math.min(window.innerHeight, pane.getBoundingClientRect().height) * 0.5 - chrome);
      el.style.maxHeight = limit + 'px';
      el.style.height = 'auto';
      el.style.height = Math.min(limit, Math.max(el.scrollHeight, composerH ?? 0)) + 'px';
      if (document.activeElement === el) revealEditorCaret(el);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [draft, composerH, surface]);

  /**
   * Drag the line between the conversation and the composer to trade one for
   * the other: up gives the message box more room for a long prompt, down gives
   * it back to the transcript. Everything else in the composer (the controls,
   * the attach row) keeps its size, so only the text box grows, and the
   * transcript is never squeezed below TRANSCRIPT_MIN_H. Double-click the line
   * to go back to growing with the draft.
   */
  const startComposerResize = (e: React.PointerEvent) => {
    const ta = composerRef.current;
    const pane = paneRef.current;
    const section = composerSectionRef.current;
    if (!ta || !pane || !section) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.getBoundingClientRect().height;
    // Whatever in the composer is not the text box, which the drag cannot shrink.
    const chrome = section.getBoundingClientRect().height - startH;
    const maxH = Math.max(COMPOSER_MIN_H, Math.min(pane.getBoundingClientRect().height - chrome - TRANSCRIPT_MIN_H, Math.min(window.innerHeight, pane.getBoundingClientRect().height) * 0.5 - chrome));
    let latest = startH;
    const onMove = (ev: PointerEvent) => {
      latest = Math.round(Math.min(maxH, Math.max(COMPOSER_MIN_H, startH + (startY - ev.clientY))));
      setComposerH(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      try { window.localStorage.setItem(COMPOSER_H_KEY, String(latest)); } catch { /* private mode */ }
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const resetComposerHeight = () => {
    setComposerH(null);
    try { window.localStorage.removeItem(COMPOSER_H_KEY); } catch { /* private mode */ }
  };

  // --- Draft persistence ---
  // The workbench only mounts the pane you're looking at, so a tab switch (or
  // quitting) tears this composer down. Park what's unsent and restore it.
  const latestDraft = useRef({ text: draft, images: pendingImages });
  latestDraft.current = { text: draft, images: pendingImages };

  // The pane is keyed by session today, so this only matters if the component is
  // ever reused for another chat. Without it, the save below would write one
  // chat's words into the next one.
  const draftLoadedFor = useRef(sessionId);
  useEffect(() => {
    if (draftLoadedFor.current === sessionId) return;
    draftLoadedFor.current = sessionId;
    const parked = loadDraft(sessionId);
    setDraft(parked?.text ?? '');
    setPendingImages(parked?.images ?? []);
  }, [sessionId]);

  // Text and images handed over from another chat (Split here) land in this
  // composer once, on top of anything already parked for it.
  const composerSeed = useStore((s) => (s.composerSeed?.sessionId === sessionId ? s.composerSeed : null));
  useEffect(() => {
    if (!composerSeed || readOnly || surface === 'transcript') return;
    useStore.setState({ composerSeed: null });
    setDraft((d) => (d.trim() ? `${d}\n\n${composerSeed.text}` : composerSeed.text));
    if (composerSeed.images.length) setPendingImages((cur) => [...cur, ...composerSeed.images.filter((i) => !cur.includes(i))]);
  }, [composerSeed, readOnly, surface]);

  useEffect(() => {
    if (readOnly || surface === 'transcript') return;
    const t = setTimeout(() => saveDraft(sessionId, latestDraft.current), 400);
    return () => clearTimeout(t);
  }, [sessionId, draft, pendingImages, readOnly, surface]);

  // Mirror the draft into the store so the Context Inspector on the right
  // counts what you're typing. Trailing by DRAFT_MIRROR_MS, so a keystroke
  // re-renders the composer and not every store subscriber; a cleared draft
  // (just sent) goes through at once so it is never counted twice.
  useEffect(() => {
    if (surface === 'transcript') return;
    if (!draft) {
      useStore.getState().setSessionDraft(sessionId, draft);
      return;
    }
    const t = setTimeout(() => useStore.getState().setSessionDraft(sessionId, draft), DRAFT_MIRROR_MS);
    return () => clearTimeout(t);
  }, [sessionId, draft, surface]);

  // Flush on unmount (tab switch, leaving the Chat view) and on window close, so
  // the last keystrokes can't be lost inside the debounce window.
  useLayoutEffect(() => {
    if (surface === 'transcript' || readOnly) return;
    // Layout cleanup flushes the outgoing composer before the incoming surface restores.
    const parked = loadDraft(sessionId);
    setDraft(parked?.text ?? '');
    setPendingImages(parked?.images ?? []);
    const flush = () => saveDraft(sessionId, latestDraft.current);
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, [sessionId, surface, readOnly]);

  // Focus the composer when a chat opens so you can start typing straight away,
  // caret after any restored draft. Runs once per chat, and never steals focus
  // from something else you're already typing in. The provider count is a
  // dependency because the textarea is disabled until providers have loaded.

  const beginTurn = () => {
    streamingRef.current = true;
    setStreaming(true);
    // Whatever was held from the last reply is about to be replaced.
    heldRef.current = null;
    setHeld(null);
    thinkingRef.current = false;
    setThinking(false);
    setDoneSummary(null);
    setErrorNotice(null);
    // The reply they suggested against is about to be replaced.
    setSuggestions(null);
    turnStart.current = Date.now();
    turnOutRef.current = 0;
    turnDecodeMsRef.current = 0;
    turnCostRef.current = 0;
    setTurnCostMeasured(0);
    setPendingIn((ctx?.items ?? []).filter((i) => i.included).reduce((n, i) => n + i.tokens, 0));
    setMarks({ ctxMark: 0, ctxTail: 0, outMark: 0 });
    setTurnOut(0);
    setTps(0);
    setMascotMood('thinking');
    // Sending pins the reader to the bottom for the reply.
    setShowJump(false);
    transcriptRef.current?.scrollToBottom();
  };

  // This chat's Auto profile: how hard Auto leans on capability (Cheap / Normal
  // / Quality). Per-chat, because a throwaway question and a refactor rarely
  // want the same spend.
  const autoQuality: AutoQuality = session?.autoQuality ?? 'normal';
  // Opt-in per chat: when this provider is spent, Auto may run the turn on an
  // equivalent model elsewhere. Never in offline chats, which must stay local.
  const autoSwitch = !!session?.autoProviderSwitch && !session?.offline;

  /** Resolve Auto mode against a prompt, with the reasoning for the chip. */
  const autoPickFor = (text: string, cross = crossModels): AutoProviderPick | null => {
    const favSet = new Set(settings?.favoriteModels ?? []);
    if (!autoSwitch || !providerId) {
      const favs = new Set(models.filter((m) => favSet.has(`${providerId}::${m.id}`)).map((m) => m.id));
      // Auto never reaches for a model the plan can't serve right now: picking a
      // capped model is a turn that fails on send rather than a smarter choice.
      const pick = pickAutoModel(runnableModels, text, { quality: autoQuality, preferred: favs });
      return pick ? { ...pick, providerId: providerId ?? '', providerLabel: activeProvider?.label ?? providerId ?? '', switched: false } : null;
    }
    return pickAcrossProviders(buildPools(cross), text, {
      quality: autoQuality,
      preferred: favSet,
      homeProviderId: providerId,
      switchOnCapacity: true,
    });
  };

  // The provider + concrete model this turn will run on: the picked ones, or,
  // in Auto mode - the best available for the prompt (favorites break ties).
  const resolveBrain = (text: string, pick?: AutoProviderPick | null): { providerId: string; modelId: string } | null => {
    if (modelId !== AUTO_MODEL_ID) return providerId && modelId ? { providerId, modelId } : null;
    const p = pick === undefined ? autoPickFor(text) : pick;
    return p && p.providerId ? { providerId: p.providerId, modelId: p.modelId } : null;
  };

  /**
   * The provider + model this turn will run on, or null after saying what's
   * missing. Sending used to fail silently here, which read as "the send button
   * is broken": the most common way in was switching tabs, since the workbench
   * unmounts a pane and the rebuilt one can land on a provider with no models.
   */
  const requireBrain = (text: string, pick?: AutoProviderPick | null): { providerId: string; modelId: string } | null => {
    const toast = (message: string) => useStore.getState().pushToast('error', message);
    if (!providerId) {
      toast(providers.length === 0
        ? 'Add a model provider in Model Providers first.'
        : 'This chat is still loading its model, try again in a moment.');
      return null;
    }
    const resolved = resolveBrain(text, pick);
    if (!resolved) {
      const label = providers.find((p) => p.id === providerId)?.label ?? 'this provider';
      toast(models.length === 0
        ? `No models available from ${label}. Start it, or pick another model below the chat.`
        : 'Pick a model below the chat first.');
      // Open the picker rather than leaving them to hunt for it.
      setModelMenuOpen(true);
      return null;
    }
    // Remembered here rather than at each call site: every turn goes through
    // this gate, so this is the one place that always knows what will run.
    modelForCostRef.current = resolved.modelId;
    return resolved;
  };

  /** One image-chat turn: the prompt goes to the chat's image model, the picture comes back as the reply. */
  const sendImage = async (prompt: string, fromDraft: boolean) => {
    if (!session) return;
    const params = { ...DEFAULT_IMAGE_CHAT_PARAMS, ...session.imageParams };
    if (!params.modelId) {
      useStore.getState().pushToast('error', 'Pick an image model below the chat first.');
      return;
    }
    try {
      const [runtime, setup] = await Promise.all([
        window.nekko.engineStatus(),
        window.nekko.engineImageCompanions(params.modelId),
      ]);
      if (!runtime.diffusionInstall?.binPath || (setup && !setup.ready)) {
        useStore.getState().pushToast('info', !runtime.diffusionInstall?.binPath
          ? 'Install the image generator using the setup button below. Your prompt is kept here.'
          : 'This model needs supporting files before it can create images. Click Finish image setup below. Your prompt is kept here.');
        return;
      }
    } catch {
      useStore.getState().pushToast('error', 'Could not check image setup. Try again or open Nekko Server.');
      return;
    }
    if (fromDraft) { setDraft(''); clearDraft(sessionId); }
    beginTurn();
    setSession((prev) => prev ? { ...prev, messages: [...prev.messages, { id: 'tmp', role: 'user', content: prompt, createdAt: Date.now() }] } : prev);
    await window.nekko.generateImageTurn({ sessionId, prompt, params: { ...params, modelId: params.modelId } });
  };

  const send = async (override?: string) => {
    if (session?.executionMode === 'sandbox') {
      try {
        const status = await window.nekko.sandboxStatus(session.id);
        if (status.phase !== 'configured' && status.phase !== 'ready') throw new Error(status.error ?? 'Configure Sandbox before executing.');
      } catch (e) { useStore.getState().pushToast('error', String((e as Error).message ?? e)); return; }
    }
    const input = override ?? draft;
    if (imageMode) {
      if (input.trim()) await sendImage(input.trim(), override === undefined);
      return;
    }
    const skill = activeSkill;
    const text = [skill ? skill.template.trimEnd() : '', input.trim()].filter(Boolean).join('\n\n');
    const images = pendingImages;
    if (!text.trim() && images.length === 0 && !skill) return;
    // A follow-up never interrupts work by accident. Queue the same payload the
    // turn would have sent so attachments and skills run when their turn arrives.
    if (streamingRef.current && !imageMode) {
      if (override === undefined) await queueDraft();
      else {
        const updated = await window.nekko.queuePrompt(sessionId, queuedPayloadFor(input, images, skill));
        if (updated) { setSession(updated); refreshSessions(); }
      }
      return;
    }

    // The `goal` skill: `/goal <condition>` starts a long-running background
    // agent that keeps working until the condition is met (not a one-off turn).
    const goalMatch = text.match(/^\/goal\s+([\s\S]+)/i);
    if (goalMatch) {
      const goal = goalMatch[1].trim();
      const brain = requireBrain(goal);
      if (!brain) return;
      await window.nekko.createTask({
        title: `Goal: ${goal.slice(0, 40)}`,
        kind: 'background',
        keepAlive: 'until',
        condition: goal,
        prompt: `Work autonomously toward this goal: ${goal}`,
        workspaceId: session?.workspaceId,
        providerId: brain.providerId,
        modelId: brain.modelId,
        intervalMs: 5 * 60_000,
      });
      useStore.getState().pushToast('success', 'Goal started as a background task, track it in Command Center.');
      if (override === undefined) { setDraft(''); clearDraft(sessionId); }
      return;
    }

    // A capacity-aware Auto pick needs the other providers' model lists; the
    // fetch resolves them fresh rather than trusting state from an old render.
    const cross = modelId === AUTO_MODEL_ID ? await ensureCrossModels() : crossModels;
    const pick = modelId === AUTO_MODEL_ID ? autoPickFor(text, cross) : null;
    const brain = requireBrain(text, pick ?? undefined);
    if (!brain) return;
    if (pick?.switched) {
      // A switch that never explains itself is a silent downgrade in waiting:
      // the reason is shown once per turn that actually moves providers.
      useStore.getState().pushToast('info', pick.reason);
    }
    if (override === undefined) { setDraft(''); setPendingImages([]); clearDraft(sessionId); }
    setActiveSkill(null);
    beginTurn();
    setSession((prev) =>
      prev ? {
        ...prev,
        messages: [...prev.messages, {
          id: 'tmp',
          role: 'user',
          content: text,
          ...(images.length ? { images } : {}),
          ...(skill ? { skill: { name: skill.name, input } } : {}),
          createdAt: Date.now(),
        }],
      } : prev,
    );
    await window.nekko.sendChat({
      sessionId,
      providerId: brain.providerId,
      modelId: brain.modelId,
      text,
      ...(images.length ? { images } : {}),
      ...(skill ? { skill: { name: skill.name, input } } : {}),
    });

    // Auto-file a project-less chat under the project it's about, inferred from
    // its attachments + first prompt, so it lands in the right sidebar group.
    // A general chat (no confident match) simply stays under "General".
    // The store's copy sees folders picked in the Context Inspector before send.
    const folders = useStore.getState().sessions.find((x) => x.id === sessionId) ?? session;
    if (session && shouldAutoFile(session, folders)) {
      const workspaces = useStore.getState().settings?.workspaces ?? [];
      const wsId = detectSessionWorkspace({ text, workspaces, attachedPaths: session.attachedPaths ?? [] });
      if (wsId) {
        const updated = await window.nekko.setSessionWorkspace(sessionId, wsId);
        if (updated) setSession(updated);
        useStore.getState().refreshSessions();
      }
    }
  };

  // Queue the draft to run after the current reply (and any earlier queued
  // items). Useful for lining up follow-ups while an agent is working.
  const queueDraft = async () => {
    const text = draft.trim();
    const images = pendingImages;
    const skill = activeSkill;
    if (!text && images.length === 0 && !skill) return;
    const updated = await window.nekko.queuePrompt(sessionId, queuedPayloadFor(text, images, skill));
    if (!updated) return;
    setDraft('');
    setPendingImages([]);
    setActiveSkill(null);
    clearDraft(sessionId);
    setSession(updated);
    refreshSessions();
  };

  // Steer the running reply with the draft: it joins the transcript at the
  // next tool boundary, the turn carries on. Ctrl/⌘+Enter while a reply runs.
  const steerDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    const updated = await window.nekko.steerChat(sessionId, text);
    setDraft('');
    clearDraft(sessionId);
    if (updated) setSession(updated);
    refreshSessions();
  };

  // Steer with a queued message instead of waiting for the turn to end.
  const steerQueued = async (index: number) => {
    const text = queueItemText(session?.queue?.[index] ?? '');
    if (!text.trim()) return;
    const updated = await window.nekko.dequeuePrompt(sessionId, index);
    if (updated) setSession(updated);
    const steered = await window.nekko.steerChat(sessionId, text);
    if (steered) setSession(steered);
    refreshSessions();
  };

  const sendQueuedNow = async (index: number) => {
    const item = session?.queue?.[index];
    if (!item) return;
    const text = queueItemText(item);
    // Resolve Auto for the queued text, not for the unsent draft. The host
    // receives a concrete provider and model before it stops the current turn.
    const cross = modelId === AUTO_MODEL_ID ? await ensureCrossModels() : crossModels;
    const pick = modelId === AUTO_MODEL_ID ? autoPickFor(text, cross) : null;
    const brain = requireBrain(text, pick ?? undefined);
    if (!brain) return;
    try {
      // IPC resolves after the turn. The host emits session_meta when it
      // consumes the queue entry so the pane updates as soon as the turn starts.
      await window.nekko.interruptQueuedPrompt(sessionId, index, brain);
    } catch {
      useStore.getState().pushToast('error', 'Could not send that queued message. Check the queue before retrying.');
    } finally {
      const fresh = await loadSession(sessionId);
      if (fresh) setSession(fresh);
      void refreshSessions();
    }
  };

  const removeQueued = async (index: number) => {
    const updated = await window.nekko.dequeuePrompt(sessionId, index);
    if (updated) setSession(updated);
    refreshSessions();
  };

  // A comment/note routed here from the editor or design board: drop it into the
  // draft ("Add to prompt") or send it now ("Run now"). Wait for the provider to
  // be ready (a freshly-opened pane loads it async) before a run-now fires.
  const composerInbox = useStore((s) => s.composerInbox);
  useEffect(() => {
    if (!composerInbox || composerInbox.sessionId !== sessionId) return;
    if (composerInbox.run && !providerId) return;
    const { text, run } = composerInbox;
    useStore.setState({ composerInbox: null });
    if (run) void send(text);
    else { setDraft((d) => (d.trim() ? d + '\n\n' : '') + text); composerRef.current?.focus(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerInbox, sessionId, providerId, streaming]);

  const editResend = async (messageId: string, newText: string) => {
    // Rewinding to a message re-sends what you attached to it too: the images
    // are read off the original before the truncate drops it, so editing the
    // words never silently costs you the screenshots that went with them.
    const original = session?.messages.find((m) => m.id === messageId);
    const images = original?.role === 'user' ? original.images ?? [] : [];
    if (!newText.trim() && images.length === 0) return;
    const brain = requireBrain(newText);
    if (!brain) return;
    await window.nekko.truncateSession(sessionId, messageId);
    beginTurn();
    setSession((prev) => {
      if (!prev) return prev;
      const idx = prev.messages.findIndex((m) => m.id === messageId);
      const kept = idx >= 0 ? prev.messages.slice(0, idx) : prev.messages;
      return {
        ...prev,
        messages: [...kept, { id: 'tmp', role: 'user', content: newText, ...(images.length ? { images } : {}), createdAt: Date.now() }],
      };
    });
    await window.nekko.sendChat({
      sessionId,
      providerId: brain.providerId,
      modelId: brain.modelId,
      text: newText,
      ...(images.length ? { images } : {}),
    });
  };

  /**
   * Copy a message into this chat's composer, text and pictures both, adding
   * to whatever is already there rather than replacing it.
   */
  const copyToComposer = (messageId: string) => {
    const m = session?.messages.find((x) => x.id === messageId);
    if (!m) return;
    const text = m.role === 'user' && m.skill ? m.skill.input : m.content;
    setDraft((d) => (d.trim() ? `${d}\n\n${text}` : text));
    if (m.images?.length) setPendingImages((cur) => [...cur, ...m.images!.filter((i) => !cur.includes(i))]);
    composerRef.current?.focus();
  };

  // Carry on from a reply that stopped part-way. The transcript is left exactly
  // as it is: every step already taken, and every tool result it produced, stays
  // and is retained for the retry.
  const resumeRun = async () => {
    // Resolve the model against the prompt this run is still working on, so Auto
    // mode picks the same tier it picked when the run started.
    const lastUser = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'user');
    const brain = requireBrain(lastUser?.content ?? '');
    if (!brain) return;
    setErrorNotice(null);
    beginTurn();
    await window.nekko.sendChat({
      sessionId,
      providerId: brain.providerId,
      modelId: brain.modelId,
      text: '',
      resume: true,
    });
  };

  const chatMarkdown = () => {
    if (!session) return '';
    const lines = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `## ${m.role === 'user' ? 'You' : 'Nekko Agent'}\n\n${m.content}`);
    return `# ${session.title}\n\n${lines.join('\n\n')}\n`;
  };
  const exportChat = () => {
    if (!session) return;
    const md = chatMarkdown();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(session.title || 'chat').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const approve = async (okDecision: boolean, scope: ApprovalScope = 'once') => {
    if (!approval) return;
    const saved = await decideApproval(window.nekko, sessionId, approval.call.id, okDecision, scope);
    if (saved.session) setSession(saved.session);
    if (saved.settings) useStore.setState({ settings: saved.settings });
    setApproval(null);
  };

  /** Unblock the turn. Clearing first keeps the card from lingering over the
   *  reply that the answer immediately produces. */
  const answerQuestion = async (answers: AskAnswer[]) => {
    const pending = question;
    if (!pending) return;
    setQuestion(null);
    await window.nekko.answerQuestion(sessionId, pending.callId, answers);
  };

  const hasProvider = !needsProviderSetup(providers, modelId ?? models[0]?.id);
  // An image chat runs on the engine's image model, not a chat provider, so it
  // can compose with no provider configured at all.
  const summaryType = useStore((st) => st.sessions.find((x) => x.id === sessionId)?.chatType);
  const imageMode = (session ? session.chatType : summaryType) === 'image';
  const canCompose = imageMode || hasProvider;
  const slashQuery = draft.startsWith('/') && !draft.includes('\n') ? draft.slice(1).toLowerCase() : null;
  const slashMatches =
    slashQuery !== null ? (settings?.prompts ?? []).filter((p) => p.name.toLowerCase().includes(slashQuery)) : [];
  // Skills (standard agent skills + installed marketplace skills) show in the
  // `/` menu until the user types args.
  const installedSkillDefs = useStore((s) => s.installedSkillDefs);
  // Rescan skills each time the `/` menu opens (not per keystroke), so a skill
  // added to ~/.claude/skills etc. while the app is open shows up.
  const slashOpen = slashQuery !== null;
  useEffect(() => {
    if (slashOpen) void useStore.getState().refreshSkills();
  }, [slashOpen]);
  const skillMatches = slashQuery !== null && !slashQuery.includes(' ') ? matchSkills(slashQuery, installedSkillDefs) : [];
  // Every skill this chat can run, in the same order `/` offers them (built-ins
  // plus installed, highlighted first). The + menu lists these.
  const allSkills = useMemo(() => matchSkills('', installedSkillDefs), [installedSkillDefs]);
  const slashMenuOpen = !menuClosed && (skillMatches.length > 0 || slashMatches.length > 0);

  const atQuery = (draft.match(/(?:^|\s)@([^\s@]*)$/) ?? [])[1] ?? null;
  const atMatches =
    atQuery !== null ? atFiles.filter((f) => f.relPath.toLowerCase().includes(atQuery.toLowerCase())).slice(0, 8) : [];
  const atMenuOpen = !menuClosed && atQuery !== null && !!session?.workspaceId;

  // Reset the highlighted menu row whenever the query changes.
  useEffect(() => { setMenuSel(0); }, [slashQuery, atQuery]);

  useEffect(() => { setAtFiles([]); }, [session?.workspaceId]);
  useEffect(() => {
    if (atQuery !== null && session?.workspaceId && atFiles.length === 0) {
      window.nekko.listFiles(session.workspaceId).then(setAtFiles).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atQuery, session?.workspaceId]);

  /** Close the + menu (and its skills flyout). */
  const closeAttachMenu = (refocus = false) => {
    setAttachMenuOpen(false);
    setSkillsHover(false);
    if (skillsFlyTimer.current) { clearTimeout(skillsFlyTimer.current); skillsFlyTimer.current = null; }
    if (refocus) attachButtonRef.current?.focus();
  };

  // Hover-intent for the Skill flyout: open immediately, close on a short delay
  // so the pointer can travel from the row to the flyout without it collapsing.
  const openSkillsFly = () => {
    if (skillsFlyTimer.current) { clearTimeout(skillsFlyTimer.current); skillsFlyTimer.current = null; }
    setSkillsHover(true);
  };
  const closeSkillsFly = () => {
    if (skillsFlyTimer.current) clearTimeout(skillsFlyTimer.current);
    skillsFlyTimer.current = window.setTimeout(() => setSkillsHover(false), 140);
  };

  const armSkill = (sk: SkillDef) => {
    setActiveSkill(sk.kind === 'goal' ? null : sk);
    setDraft((current) => draftAfterSkillSelection(current, sk));
    composerRef.current?.focus();
  };

  // Pick a slash-menu row by its combined index (skills first, then prompts).
  const pickSlashIndex = (i: number) => {
    if (i < skillMatches.length) {
      armSkill(skillMatches[i]);
      return;
    }
    const p = slashMatches[i - skillMatches.length];
    if (p) { setDraft(p.body); composerRef.current?.focus(); }
  };

  const pickFile = async (f: IndexedFile) => {
    if (!session) return;
    const next = Array.from(new Set([...(session.attachedPaths ?? []), f.path]));
    await window.nekko.setSessionAttachments(session.id, next);
    setDraft((d) => d.replace(/(?:^|\s)@([^\s@]*)$/, (full) => (/^\s/.test(full) ? ' ' : '') + '@' + f.relPath + ' '));
    setSession(await window.nekko.getSession(session.id));
    refreshCtx();
    composerRef.current?.focus();
  };

  // Suggestions only count while the reply they were written for is still the
  // latest word; anything newer retires them.
  const lastMsgId = session?.messages[session.messages.length - 1]?.id;
  const liveSuggestions = suggestions && suggestions.forId === lastMsgId ? suggestions : null;
  const canContinueReply = !!errorNotice && !question && !streaming && hasResumableProgress(session?.messages ?? []);
  // A transcript that ends on a cut-off reply (the app was closed mid-run, the
  // host restarted) has no `error` event left to announce it, so the notice is
  // read off the record itself. Dismissing it is remembered per reply.
  const [dismissedInterruption, setDismissedInterruption] = useState<string | null>(null);
  useEffect(() => {
    if (errorNotice || !session || dismissedInterruption === lastMsgId) return;
    if (shouldShowPersistedInterruption(session.messages, streaming, !!held || finalizingReply.current, !!question)) setErrorNotice(PERSISTED_INTERRUPTION);
  }, [session, streaming, held, errorNotice, lastMsgId, dismissedInterruption, question]);
  const canContinueWork = !streaming && !held && !session?.activeRun && !errorNotice &&
    session?.messages.at(-1)?.role === 'assistant' && hasResumableProgress(session.messages);
  // Suppress suggestions while recovery actions are visible.
  const suggestedOptions = errorNotice ? [] : liveSuggestions?.options ?? [];

  // The model's single most likely next message, shown as the composer's
  // placeholder while the box is empty; ArrowRight types it in.
  const ghostSuggestion = !draft && !errorNotice && liveSuggestions?.next ? liveSuggestions.next : null;

  const onComposerKeyDown = (e: React.KeyboardEvent<MarkdownEditorElement>) => {
    if (e.nativeEvent.isComposing) return;
    const menuCount = slashMenuOpen ? skillMatches.length + slashMatches.length : atMenuOpen ? atMatches.length : 0;
    if (slashMenuOpen || atMenuOpen) {
      // Escape closes the menu and keeps the draft; typing re-opens it.
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuClosed(true);
        return;
      }
      if (menuCount > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setMenuSel((s) => (s + 1) % menuCount); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setMenuSel((s) => (s - 1 + menuCount) % menuCount); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const i = Math.min(menuSel, menuCount - 1);
          if (slashMenuOpen) pickSlashIndex(i);
          else void pickFile(atMatches[i]);
          return;
        }
      }
    }
    // → accepts the ghost suggestion while the box is empty (the box is empty
    // whenever a ghost is showing, so the caret is already at the end).
    if (e.key === 'ArrowRight' && ghostSuggestion && !e.currentTarget.value) {
      e.preventDefault();
      const el = e.currentTarget;
      setDraft(ghostSuggestion);
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
      return;
    }
    // Tab on a list line indents it (Shift+Tab outdents); anywhere else the
    // key keeps moving focus, as it does in any form.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const el = e.currentTarget;
      const edit = indentListSelection(el.value, el.selectionStart, el.selectionEnd, e.shiftKey);
      if (edit) {
        e.preventDefault();
        setDraft(edit.text);
        requestAnimationFrame(() => el.setSelectionRange(edit.selectionStart, edit.selectionEnd));
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Ctrl/⌘+Enter while a reply runs steers it; Enter queues the follow-up.
      if ((e.ctrlKey || e.metaKey) && streamingRef.current && !imageMode) void steerDraft();
      else void send();
    }
  };

  const openImageMenu = useCallback((e: React.MouseEvent, src: string) => {
    e.preventDefault();
    e.stopPropagation();
    setImageMenu({ x: e.clientX, y: e.clientY, src });
  }, []);

  const addImages = async (files: File[]) => {
    const images = await Promise.all(files.map((file) => readImage(file).catch(() => null)));
    setPendingImages((current) => [...current, ...images.filter((image): image is string => !!image)]);
  };

  const onPaste = (e: React.ClipboardEvent<MarkdownEditorElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  };

  const addFiles = async () => {
    const picked = await window.nekko.openFilesDialog();
    if (!session || !picked.length) return;
    const next = Array.from(new Set([...(session.attachedPaths ?? []), ...picked]));
    await window.nekko.setSessionAttachments(session.id, next);
    setSession(await window.nekko.getSession(session.id));
    refreshCtx();
  };

  const providerKind = providers.find((p) => p.id === providerId)?.kind;
  const activeProvider = providers.find((p) => p.id === providerId);
  // This provider's live usage windows, and the models they still leave usable.
  const providerLimits = useProviderLimits(activeProvider);
  const runnableModels = models.filter(
    (m) => resolveModelAvailability({ model: m, provider: activeProvider, limits: providerLimits }).status === 'ready',
  );

  /**
   * This chat's provider as a pool: its models, whatever live limits it
   * publishes, and whether its turns are free (local or plan-included), which
   * is what the cross-provider pick weighs against every other pool.
   */
  const homePool: ProviderPool | null = providerId
    ? {
        providerId,
        providerLabel: activeProvider?.label ?? providerId,
        models,
        limits: providerLimits,
        auth: activeProvider?.auth,
        tokenKey: activeProvider?.tokenKey,
        local: providerKind ? isLocalProvider(providerKind) : undefined,
      }
    : null;

  const [crossModels, setCrossModels] = useState<Record<string, ModelInfo[]>>({});
  // Every provider's limits, read only while Auto could actually move a turn
  // off this provider.
  const crossLimits = useAllProviderLimits(providers, modelId === AUTO_MODEL_ID && autoSwitch);

  /**
   * The other providers' model lists, fetched once when the chat is in Auto
   * mode with follow-capacity on: either switch trigger (spent provider or a
   * materially cheaper same-tier model elsewhere) needs the full pool, and
   * neither can be evaluated without it. Returns the fresh map for callers
   * that cannot wait a render, since `setState` inside this closure is stale.
   */
  const ensureCrossModels = async (): Promise<Record<string, ModelInfo[]>> => {
    if (modelId !== AUTO_MODEL_ID || !autoSwitch) return crossModels;
    if (Object.keys(crossModels).length) return crossModels;
    const entries = await Promise.all(
      providers
        .filter((p) => p.enabled && p.id !== providerId)
        .map((p) =>
          window.nekko
            .listModels(p.id)
            .then((m) => [p.id, m] as const)
            .catch(() => [p.id, [] as ModelInfo[]] as const),
        ),
    );
    const fresh = Object.fromEntries(entries);
    setCrossModels(fresh);
    return fresh;
  };
  useEffect(() => {
    if (modelId === AUTO_MODEL_ID && autoSwitch) void ensureCrossModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSwitch, modelId]);

  /** The pools a capacity-aware Auto pick can draw on: home first, then every
   *  other enabled provider whose models we have fetched. */
  const buildPools = (cross: Record<string, ModelInfo[]>): ProviderPool[] => [
    ...(homePool ? [homePool] : []),
    ...providers
      .filter((p) => p.enabled && p.id !== providerId)
      .map((p) => {
        const key = limitsKeyFor(p);
        return {
          providerId: p.id,
          providerLabel: p.label,
          models: cross[p.id] ?? [],
          limits: key ? crossLimits[key] : undefined,
          auth: p.auth,
          tokenKey: p.tokenKey,
          local: isLocalProvider(p.kind),
        };
      }),
  ];

  const isCloudModel = !providerKind || !isLocalProvider(providerKind);
  // Reasoning toggle: offered only for a concrete, reasoning-capable model.
  const selectedModelInfo = modelId && modelId !== AUTO_MODEL_ID ? models.find((m) => m.id === modelId) : undefined;
  const thinkingSupported = !!modelId && modelId !== AUTO_MODEL_ID && modelSupportsThinking({ id: modelId, name: selectedModelInfo?.name });
  const thinkingOn = session?.thinking !== false;
  const setThinkingPref = (value: boolean) => {
    window.nekko.setSessionOptions(sessionId, { thinking: value }).then((s) => { if (s) setSession(s); }).catch(() => {});
  };

  // Auto mode: the model the next message will actually run on. Shown whether or
  // not anything is typed yet - "Auto" alone tells you nothing, and the pick
  // moves as you type, which is exactly what's worth watching.
  // Read from the deferred draft, like the analyzer and the plan rail below:
  // the characters you type paint first, and what they imply follows a moment
  // later without holding the keystroke up.
  const autoPick = modelId === AUTO_MODEL_ID ? autoPickFor(deferredDraft) : null;

  // Nothing picked yet, but there is something to pick from: guide the choice
  // instead of failing on send.
  const needsModel = hasProvider && modelsLoaded && !modelId;
  // A tooltip on the model chip, not a banner in the strip: the nudge points at
  // the control that answers it and costs no layout while it waits.
  // Inline, and only where the user is driving the chat: the wall's composer
  // (always the selected window's) or a full pane. A wall of transcript windows
  // must not each grow a popup when one provider goes away.
  const drivesChat = surface === 'transcript' ? selected === true : true;
  const modelHint =
    needsModel && !modelHintDone && drivesChat
      ? unavailableModel
        ? `${unavailableModel} is not available right now${models.length === 0 ? ' (this provider has no models loaded)' : ''}. Select a model again.`
        : models.length === 0
          ? 'This provider has no models loaded. Start it, or pick another provider.'
          : 'This chat needs a model before it can reply.'
      : null;
  // Any route into the picker counts as the nudge being read.
  const openModelMenu = (open: boolean) => {
    setModelMenuOpen(open);
    if (open) setModelHintDone(true);
  };

  const queued = session?.queue ?? [];

  /**
   * How wide the conversation and its controls run inside the pane.
   *
   * Three quarters, not a fixed 768px column: on a desktop workbench pane the
   * old cap left the composer at about half the width with dead margin on both
   * sides. When the plan rail is showing it already takes the right quarter, so
   * the column below it goes full width rather than indenting twice.
   */
  // Full width beside the open rail keeps clear of the floating plan toggle.
  const contentWidth = planRailOpen ? 'mx-auto w-full pr-11' : paneWidth < NARROW_PANE ? 'mx-auto w-full' : 'mx-auto w-[75%]';

  // --- The transcript, as windowed rows ---
  const messages = session?.messages;
  const rows = useMemo(
    () => (messages ? toTranscriptRows(messages, extractPrUrls, collectSessionPrUrls, prs) : []),
    [messages, prs],
  );
  // Every PR the transcript mentions, scanned once per transcript: the scan is
  // a regular expression over every message, and it used to run on every
  // render of the pane, including each streaming frame.
  const sessionPrUrls = useMemo(() => (messages ? collectSessionPrUrls(messages) : []), [messages]);
  const prByUrl = useMemo(() => new Map(prs.map((p) => [p.url, p])), [prs]);
  // Handlers handed to rows go through refs, so a row never re-renders because
  // this pane re-rendered.
  const editResendRef = useRef(editResend);
  editResendRef.current = editResend;
  const onEditResend = useCallback((id: string, text: string) => { void editResendRef.current(id, text); }, []);
  const copyToComposerRef = useRef(copyToComposer);
  copyToComposerRef.current = copyToComposer;
  const onCopyToComposer = useCallback((id: string) => copyToComposerRef.current(id), []);
  const onSplit = useCallback((id: string) => { void useStore.getState().splitChat(sessionId, id); }, [sessionId]);
  const artifactBasePath = session?.workspaceId ? session.gitWorktrees?.[session.workspaceId]?.path ?? settings?.workspaces.find((w) => w.id === session.workspaceId)?.path : undefined;
  const renderRow = useCallback(
    (row: TranscriptRow) => (
      <TranscriptRowView
        row={row}
        basePath={artifactBasePath}
        streaming={streaming}
        readOnly={readOnly}
        prByUrl={prByUrl}
        sessionId={sessionId}
        onEditResend={onEditResend}
        onCopyToComposer={onCopyToComposer}
        onSplit={onSplit}
        onImageClick={setLightbox}
        onImageContextMenu={openImageMenu}
      />
    ),
    [artifactBasePath, streaming, readOnly, prByUrl, sessionId, onEditResend, onCopyToComposer, onSplit, openImageMenu],
  );
  // Width of the text column, for the height estimates of rows not yet measured.
  const columnWidth = Math.max(0, (paneWidth || 800) * (contentWidth.includes('75%') ? 0.75 : 1) - 32);
  const estimate = useCallback((row: TranscriptRow) => estimateRowHeight(row, columnWidth), [columnWidth]);
  const hasLive = !!(held || getLiveRun(sessionId));
  const welcomeState = chatWelcomeState({ messages: session?.messages.length ?? 0, streaming, hasLive, hasProvider, modelId, imageMode });
  const onCompacted = useCallback(() => {
    refreshCtxRef.current();
    loadSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
  }, [sessionId]);
  const skillTokens = useMemo(
    () => (activeSkill ? { name: activeSkill.name, tokens: estimateTokens(activeSkill.template) } : null),
    [activeSkill],
  );
  const ctxUsed = useMemo(() => (ctx ? ctx.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0) : 0), [ctx]);

  // The model and its effort sit in the bottom bar, between the attach button
  // and the context gauge, where the eye already is when sending.
  const modelControls = (
    <div className="flex min-w-0 shrink items-center gap-2 rounded-lg">
    <ModelPicker
      providers={providers}
      providerId={providerId}
      models={models}
      modelId={modelId}
      open={modelMenuOpen}
      onOpenChange={openModelMenu}
      needsChoice={needsModel}
      unavailableModel={needsModel ? unavailableModel : null}
      onProvider={setProviderId}
      onModel={(pid, v) => {
        if (session?.messages.length && (pid !== providerId || v !== modelId)) {
          contextNoticeTrigger.current = paneRef.current?.querySelector('button[aria-haspopup="listbox"]') ?? null;
          setContextChangeNotice(true);
        }
        if (pid) setProviderId(pid);
        setModelId(v);
        setUnavailableModel(null);
        // Park the pick on the chat itself. Switching tabs unmounts
        // this pane, so a renderer-only choice was lost on the way
        // back and the chat fell back to its old provider (which may
        // have no models at all, leaving it unsendable).
        const auto = v === AUTO_MODEL_ID;
        window.nekko
          .setSessionOptions(sessionId, {
            autoModel: auto,
            ...(pid ? { providerId: pid } : {}),
            ...(auto ? {} : { modelId: v }),
          })
          .then((s) => { if (s) window.dispatchEvent(new CustomEvent('nekko-session-brain', { detail: { id: sessionId, session: s } })); })
          .catch((e) => useStore.getState().pushToast('error', String(e)));
      }}
    />
    <EffortSlider onChanged={() => { if (session?.messages.length) { contextNoticeTrigger.current = document.activeElement as HTMLElement; setContextChangeNotice(true); } }} modelId={autoPick?.modelId ?? (modelId === AUTO_MODEL_ID ? undefined : modelId ?? undefined)} />
    </div>
  );

  return (
    <MarkdownSandbox.Provider value={session?.executionMode === 'sandbox'}>
    <div ref={paneRef} onContextMenu={(e) => { if (surface === 'composer' || e.defaultPrevented || (e.target as HTMLElement).closest('a, img, textarea, [contenteditable], [data-agent-logs]')) return; e.preventDefault(); setChatMenu({ x: e.clientX, y: e.clientY }); }} data-session-id={sessionId} data-chat-surface={surface} className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
      {contextChangeNotice && <Modal title="Context on your next reply" zIndex={100} overlayClassName="p-4" className="w-full max-w-md rounded-xl border border-line bg-surface p-5 text-ink shadow-xl" onClose={closeContextNotice}>
            <h2 className="font-semibold">Context on your next reply</h2>
            <p className="mt-3 text-sm text-ink-soft">Your selection is saved. Changing the model or effort does not send a request now or change an already-running reply. The next reply sends the assembled chat context again, as ordinary follow-up replies do.</p>
            <p className="mt-3 text-sm text-ink-soft">{ctx ? 'Estimated input context: ~' + ctxUsed.toLocaleString() + ' tokens.' : 'Input context estimate is unavailable.'} History may be compacted or trimmed; caching and billing depend on the provider. A different model may not reuse cached context. Effort applies to all chats.</p>
            <p className="mt-3 text-sm text-ink-soft">To reduce input tokens, you can open a new chat instead and include only the information it needs.</p>
            <button className="btn btn-primary mt-4" onClick={closeContextNotice}>Got it</button>
      </Modal>}
      {chatMenu && <ContextMenu x={chatMenu.x} y={chatMenu.y} onClose={() => setChatMenu(null)}>
        <ContextAction onClick={() => { void navigator.clipboard.writeText(chatMarkdown()).catch(() => useStore.getState().pushToast('error', "Couldn't copy chat.")); setChatMenu(null); }}><CopyIcon className="mr-2 inline h-3.5 w-3.5" />Copy chat</ContextAction>
        <ContextAction onClick={() => { exportChat(); setChatMenu(null); }}><DownloadIcon className="mr-2 inline h-3.5 w-3.5" />Export as Markdown</ContextAction>
      </ContextMenu>}
      <section className="flex min-w-0 w-full flex-1 flex-col overflow-x-hidden">
        {/* One bar per window. Inside a workspace these ride in the frame's
            title strip, which already shows the chat's name; standalone, the
            chat still needs a header of its own. */}
        {surface !== 'composer' && (
        <ChatHeader title={session?.title || 'New chat'} subAgent={Boolean(session?.parentSessionId)} inWall={commandCenter} metadata={
            git && (
              <span className="flex min-w-0 shrink items-center gap-1 text-[11px]">
                {session && <WorktreeChip session={session} git={git} disabled={hasLive} onChange={setSession} />}
              </span>
            )}>
            {/* This agent's companions sit with its other tools (Logs) rather
                than in the wall's title bar, where they needed an agent to be
                selected first. On the wall they open beside the window; in
                the Chat view, as windows of the workspace. */}
            <AgentCompanionButtons sessionId={sessionId} changeCount={changeCount} commandCenter={commandCenter} compact={compact} />
            <button
              className="btn btn-ghost shrink-0 px-2 py-1 text-[11px]"
              aria-label="Open agent logs"
              aria-expanded={commandCenter ? logsOpen : undefined}
              disabled={session?.executionMode === 'sandbox'}
              // On the Agents wall the log slides out of this window's right
              // edge as its own drawer (CommandWall lays it out and moves the
              // windows beside it); the Chat view's workbench keeps opening it
              // as a window beside the chat.
              onClick={() => {
                if (session?.executionMode === 'sandbox') return;
                commandCenter ? useWallLogs.getState().toggle(sessionId) : useStore.getState().openTerminalPane(`agent_${sessionId}`);
              }}
              title="Open the agent's command log"
            >
              {compact ? <TerminalIcon className="h-4 w-4" /> : 'Logs'}
            </button>

            {!compact && (
            <button
              className={`btn btn-ghost hidden px-2 py-1 lg:inline-flex ${ctxOpen ? 'text-accent' : ''}`}
              onClick={() => useStore.getState().toggleContextPanel()}
              title="Toggle context panel (Ctrl/⌘+\)"
              aria-pressed={ctxOpen}
            >
              <PanelIcon />
            </button>
            )}
        </ChatHeader>
        )}

        {/* A question the agent stopped to ask stays pinned at the top of the
            window, above the transcript, where it cannot scroll away or sit
            under the history. It says what it is plainly, in the warning tone
            the window's ring wears. */}
        {surface === 'transcript' && question && (
          <div className="agent-question-pin shrink-0" data-agent-question role="region" aria-label="The agent asked you a question">
            <p className="agent-question-pin-label"><QuestionIcon className="h-3.5 w-3.5" /> Asked you a question</p>
            <div className="agent-question-pin-body"><QuestionCard key={question.callId} request={question} onAnswer={(answers) => { void answerQuestion(answers); }} onSkip={() => { void answerQuestion([]); }} tone="attention" /></div>
          </div>
        )}
        {surface !== 'composer' && (
        <div className="relative flex min-h-0 w-full flex-1">
          <VirtualTranscript
            ref={transcriptRef}
            rows={rows}
            renderRow={renderRow}
            estimate={estimate}
            cacheKey={sessionId}
            className={`${contentWidth} space-y-5`}
            onPinnedChange={onPinnedChange}
            onGrowWhileUnpinned={onGrowWhileUnpinned}
            header={welcomeState.welcome ? (

              <div className="fade-in mt-16 flex flex-col items-center gap-3 text-center">
                {!hasProvider ? <SetupIllustration /> : <div className="grid h-12 w-12 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={30} /></div>}
                <div>
                  <h2 className="text-[15px] font-semibold">
                    {!hasProvider ? 'Bring your first agent to life' : imageMode ? 'What should Nekko Agent draw?' : needsModel ? 'Pick a model to get started' : 'What should Nekko Agent work on?'}
                  </h2>
                  <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-faint">
                    {!hasProvider
                      ? 'Connect an AI account or a local model. We’ll walk you through it — no technical experience needed.'
                      : needsModel
                        ? 'Choose a model here, or let Auto pick per message.'
                        : 'Ask a question or hand over a task. Use / for skills and prompts, @ to attach files, + for photos and folders.'}
                  </p>
                </div>
                {!hasProvider ? (
                  <button className="btn btn-primary" onClick={() => useStore.getState().setView('models')}>Set up my first agent →</button>
                ) : null}
                {surface !== 'transcript' && welcomeState.modelChoice && <div className="mt-4 flex h-[min(50vh,440px)] w-full max-w-xl flex-col gap-2 text-left">
                  <div className="flex items-center justify-between gap-2 px-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Choose a model</span>

                  </div>
                  {imageMode && session ? <ImageModeControls session={session} onChange={setSession} busy={streaming} /> :
                    <ModelPicker providers={providers} providerId={providerId} models={models} modelId={modelId}
                      open={false} onOpenChange={openModelMenu} expanded
                      recent={recentModels}
                      onProvider={setProviderId} onModel={(pid, mid) => { setProviderId(pid); setModelId(mid); setUnavailableModel(null); void window.nekko.setSessionOptions(sessionId, { providerId: pid, modelId: mid, autoModel: mid === AUTO_MODEL_ID }).then((s) => { if (s) window.dispatchEvent(new CustomEvent('nekko-session-brain', { detail: { id: sessionId, session: s } })); }).catch((e) => useStore.getState().pushToast('error', String(e))); }} />}
                </div>}
              </div>
            ) : undefined}
            footer={
              <>
                {/* The reply being written: repaints once a frame on its own. */}
                {imageMode
                  ? <ImageLiveTurn sessionId={sessionId} streaming={streaming} />
                  : <LiveTurn sessionId={sessionId} held={held} onImageClick={setLightbox} />}
                <LiveReplyStatus
                  sessionId={sessionId}
                  startedAt={turnStart.current}
                  streaming={streaming}
                  tps={tps}
                  out={turnOut}
                  last={lastTurn}
                  done={doneSummary}
                  persisted={!streaming && !![...(session?.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.turnStats}
                  blocked={errorNotice ? 'Needs attention' : approval ? 'Waiting for approval' : question ? 'Waiting for your answer' : null}
                />
                {errorNotice && !question && !streaming && (() => {
                  // A stop the user asked for is not a failure, so it doesn't wear
                  // the failure colour. Either way the run is resumable whenever it
                  // left something behind: the steps it finished are on disk, so
                  // Resume carries on rather than starting the work again.
                  const canResume = canContinueReply;
                  const interruption = describeInterruption(errorNotice, canResume);
                  const tone = interruption.paused ? 'var(--warning)' : 'var(--danger)';
                  return (
                  <div
                    className="fade-in flex flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2 text-[12px]"
                    style={{
                      borderColor: `color-mix(in srgb, ${tone} 35%, transparent)`,
                      background: `color-mix(in srgb, ${tone} 7%, transparent)`,
                    }}
                    role="alert"
                  >
                    <span className="shrink-0 font-medium" style={{ color: tone }}>
                      {interruption.title}
                    </span>
                    <span className="min-w-0 basis-48 flex-1 text-ink-soft">
                      {interruption.detail} Retrying sends approximately {ctx ? ctxUsed.toLocaleString() : 'an unavailable number of'} input context tokens. Provider caching and billing vary.
                    </span>
                    {session?.messages.some((m) => m.role === 'user') && (
                      <button className="btn btn-primary shrink-0 px-2.5 py-0.5 text-[11px]"
                        title="Retry using the saved conversation and work" onClick={() => void resumeRun()}>
                        Retry
                      </button>
                    )}
                    <button className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink" title="Dismiss" onClick={() => { setDismissedInterruption(lastMsgId ?? null); setErrorNotice(null); }}>
                      <CloseIcon className="h-3 w-3" />
                    </button>
                  </div>
                  );
                })()}
                <LiveContextWarning
                  sessionId={sessionId}
                  marks={marks}
                  baseUsed={ctxUsed}
                  windowTokens={selectedModelInfo?.contextLength ?? ctx?.contextWindow ?? 0}
                  session={session}
                  streaming={streaming}
                  onCompacted={onCompacted}
                />

              </>
            }
          />
          {/* The plan panel's toggle floats in the chat area's top-right corner,
              in its own place whether the panel is open or not. */}
          {wideEnoughForRail && (
            <button
              type="button"
              className={`plan-rail-toggle ${planRailOpen ? 'is-open' : ''}`}
              data-plan-toggle
              onClick={() => useStore.getState().togglePlanRail()}
              title={planRailOpen ? 'Hide the plan panel' : 'Show the plan, sub-agents and queue panel'}
              aria-label={planRailOpen ? 'Hide the plan panel' : 'Show the plan panel'}
              aria-pressed={planRailOpen}
            >
              <ListIcon className="h-4 w-4" />
              {!planRailOpen && planSteps.total > 0 && <span className="plan-rail-toggle-count tabular-nums">{planSteps.done}/{planSteps.total}</span>}
            </button>
          )}
          {showJump && (
            <button
              className="fade-in absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line px-3 py-1 text-[12px] font-medium text-ink-soft shadow-md hover:text-ink"
              style={{ background: 'var(--surface)' }}
              onClick={jumpToLatest}
            >
              ↓ Jump to latest
            </button>
          )}
        </div>
        )}

        {approval && surface !== 'composer' && <ApprovalBar approval={approval} onDecide={approve} />}

        {readOnly ? (
          surface === 'transcript' ? null : <ArchivedChatBar sessionId={sessionId} contentWidth={contentWidth} archivedAt={session?.archivedAt ?? null} />
        ) : surface === 'transcript' ? null : (
        <div ref={composerSectionRef} className={`composer-section relative ${commandCenter ? '' : 'px-4'} pb-4 pt-1.5`}>
          {/* The resize grip rides the composer's top border: a wide invisible
              hit area over a hairline that lights up on hover. */}
          {surface !== 'composer' && <div
            className="group absolute inset-x-0 -top-1.5 z-10 h-3 cursor-row-resize"
            onPointerDown={startComposerResize}
            onDoubleClick={resetComposerHeight}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the message box"
            title="Drag to resize the message box · double-click to reset"
          >
            <span className="absolute inset-x-0 top-[5px] h-0.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ background: 'color-mix(in srgb, var(--accent) 45%, transparent)' }} />
            <span className="absolute left-1/2 top-[3px] h-1.5 w-10 -translate-x-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100" style={{ background: 'var(--accent)' }} />
          </div>}
          <div className={`composer-column mx-auto ${commandCenter ? 'w-[98%]' : 'w-[90%]'}`} style={commandCenter ? { width: '98%' } : undefined}>
            {surface !== 'composer' && <ComposerQuestion request={question} onAnswer={(answers) => { void answerQuestion(answers); }} />}

            <div className="composer relative">
            {/* While the agent works, a violet→cyan beam laps the border. The
                gradient is a square that rotates on the compositor, clipped
                to the ring by the mask on its wrapper; animating the gradient
                angle itself repainted the whole composer every frame, in every
                working window on the wall at once. */}
            {streaming && <span className="composer-beam-ring" aria-hidden><span className="composer-beam-spin" /></span>}
            {compact && (
              <div className="composer-summary">
                <button
                  className="composer-summary-chip"
                  onClick={() => setControlsOpen((o) => !o)}
                  aria-expanded={controlsOpen}
                  title={controlsOpen ? 'Hide the model, mode and tool controls' : 'Show the model, mode and tool controls for this chat'}
                >
                  <span className="composer-summary-model">{imageMode ? 'Image' : modelId === AUTO_MODEL_ID ? 'Auto' : selectedModelInfo?.name ?? modelId ?? 'Pick a model'}</span>
                  <span className="composer-summary-meta">
                    {!imageMode && ` \u00b7 ${MODE_LABEL[session?.mode ?? settings?.defaultChatMode ?? 'guardrails']}`}
                    {thinkingSupported && ` \u00b7 Thinking ${thinkingOn ? 'on' : 'off'}`}
                    {session?.offline && ' \u00b7 Offline'}
                    {session?.incognito && ' \u00b7 Incognito'}
                  </span>
                  <span className="ctl-caret">{controlsOpen ? '\u25b4' : '\u25be'}</span>
                </button>
                {!imageMode && (
                  <button
                    className="ctl-toggle ml-auto shrink-0 whitespace-nowrap"
                    onClick={() => setScheduleOpen(true)}
                    aria-label="Automate: schedule, repeat, or run in the background"
                    title="Automate: schedule, repeat, or run in the background"
                  >
                    <span style={{ color: 'var(--warning)' }}><BoltIcon className="h-3 w-3" /></span> Automate
                  </button>
                )}
              </div>
            )}
            {header && (
              <div className="composer-head flex min-w-0 items-center gap-1.5 border-b border-line px-2 py-1 text-[12px]" data-composer-head>
                {header}
                {!imageMode && (
                  <button
                    className="ctl-toggle shrink-0 whitespace-nowrap"
                    onClick={() => setScheduleOpen(true)}
                    aria-label="Automate: schedule, repeat, or run in the background"
                    title="Automate: schedule, repeat, or run in the background"
                  >
                    <span style={{ color: 'var(--warning)' }}><BoltIcon className="h-3 w-3" /></span> Automate
                  </button>
                )}
              </div>
            )}
            {showControls && !header && (<>
            {/* Chat-wide switches live at the top of the input surface; the
                model and its effort sit in the bottom bar beside Send. */}
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
              <div className="min-w-0 shrink">
              <ChatControls
                session={session}
                isCloudModel={isCloudModel}
                onChange={setSession}
                toolsInWindow
              />
              </div>
              {!imageMode && (<>
              {modelId === AUTO_MODEL_ID && (
                <AutoQualityMenu
                  quality={autoQuality}
                  onPick={(q) => {
                    window.nekko
                      .setSessionOptions(sessionId, { autoQuality: q })
                      .then((s) => { if (s) setSession(s); })
                      .catch(() => {});
                  }}
                  followCapacity={!!session?.autoProviderSwitch}
                  onFollowCapacity={(v) => {
                    window.nekko
                      .setSessionOptions(sessionId, { autoProviderSwitch: v })
                      .then((s) => { if (s) setSession(s); })
                      .catch(() => {});
                  }}
                />
              )}
              {autoPick && (
                <span
                  className="min-w-0 shrink truncate text-[10px] text-ink-faint"
                  title={`Auto will run this message on ${autoPick.name}. ${autoPick.reason}`}
                >
                  → {autoPick.name}{autoPick.switched ? ` · ${autoPick.providerLabel}` : ''}
                </span>
              )}
              {thinkingSupported ? (
                <button
                  className="ctl-toggle whitespace-nowrap"
                  onClick={() => setThinkingPref(!thinkingOn)}
                  aria-pressed={thinkingOn}
                  title={thinkingOn ? 'Reasoning is on for this chat — click to turn off' : 'Reasoning is off for this chat — click to turn on'}
                >
                  <span className={`ctl-dot ${thinkingOn && streaming ? 'animate-pulse' : ''}`} />
                  <ThoughtIcon className="h-3 w-3" /> Thinking {thinkingOn ? 'on' : 'off'}
                </button>
              ) : thinking ? (
                <span
                  className="ctl-toggle ctl-toggle-on whitespace-nowrap"
                  title="The model streamed reasoning while writing this reply"
                >
                  <span className={`ctl-dot ${streaming ? 'animate-pulse' : ''}`} />
                  <ThoughtIcon className="h-3 w-3" /> Thinking
                </span>
              ) : null}
              </>)}
              {!imageMode && (
                <button
                  className="ctl-toggle ml-auto shrink-0 whitespace-nowrap"
                  onClick={() => setScheduleOpen(true)}
                  aria-label="Automate: schedule, repeat, or run in the background"
                  title="Automate: schedule, repeat, or run in the background"
                >
                  <span style={{ color: 'var(--warning)' }}><BoltIcon className="h-3 w-3" /></span> Automate
                </button>
              )}
            </div>
            </>)}
            {showControls && imageMode && session && (
              <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
                <ImageModeControls session={session} onChange={setSession} busy={streaming} />
              </div>
            )}

            {/* Queued follow-ups expand inside the same surface as the input. */}
            <div className={`collapse-wrap ${queued.length > 0 ? '' : 'collapsed'}`} aria-hidden={queued.length === 0}>
              <div className="min-h-0 overflow-hidden">
                <div className="border-b border-line bg-surface-2 px-3 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-faint">
                    <ListIcon className="h-3 w-3" /> Queued · {queued.length} {streaming ? 'after this reply' : 'waiting to run'}
                  </div>
                  <div className="space-y-1">
                    {queued.map((q, i) => {
                      const payload = queueItemPayload(q);
                      const label = queuedTitle(q);
                      return (
                      <div key={i} className="flex items-center gap-2 text-[12px]">
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-soft" title={label}>{payload.text || '(no text)'}</span>
                        {payload.skill && <span className="skill-pill shrink-0 text-[10px]" title={`Skill: ${payload.skill.name}`}><span className="skill-pill-slash">/</span>{payload.skill.name}</span>}
                        {!!payload.images?.length && <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-ink-faint">{payload.images.length} image{payload.images.length === 1 ? '' : 's'}</span>}
                        {streaming && !payload.images?.length && !payload.skill && <button className="shrink-0 rounded-md px-2 py-0.5 text-accent hover:bg-surface" title="Steer the running reply with this message at its next step, without stopping it" onClick={() => void steerQueued(i)}>Steer</button>}
                        {streaming && <button className="shrink-0 rounded-md px-2 py-0.5 text-accent hover:bg-surface" title="Interrupt the current reply and send this message now" onClick={() => void sendQueuedNow(i)}>Send now</button>}
                        <button
                          className="shrink-0 rounded-sm px-1 text-ink-faint hover:text-(--danger)"
                          title="Remove from queue"
                          onClick={() => removeQueued(i)}
                        >
                          ✕
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="composer-editing-body relative w-full">
              {atMenuOpen && (
                <div
                  className="card absolute bottom-full left-0 z-40 mb-2 w-full max-w-md overflow-hidden p-1.5 shadow-lg"
                  id={`at-menu-${sessionId}`}
                  role="listbox"
                  aria-label="Attach a file"
                >
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Attach a file</div>
                  {atMatches.length === 0 ? (
                    <div className="px-2.5 py-1.5 text-[11px] text-ink-faint">{atFiles.length === 0 ? 'Attach a project folder (+ → Folder) to mention its files.' : 'No matching files.'}</div>
                  ) : (
                    atMatches.map((f, i) => (
                      <button
                        key={f.path}
                        role="option"
                        aria-selected={i === menuSel}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${i === menuSel ? 'bg-surface-2' : ''}`}
                        onClick={() => pickFile(f)}
                        onMouseEnter={() => setMenuSel(i)}
                      >
                        <span className="font-mono text-[12px] text-accent">@{f.relPath}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {slashMenuOpen && (
                <div
                  className="card absolute bottom-full left-0 z-40 mb-2 max-h-80 w-full max-w-md overflow-y-auto p-1.5 shadow-lg"
                  id={`slash-menu-${sessionId}`}
                  role="listbox"
                  aria-label="Skills and prompts"
                >
                  {skillMatches.length > 0 && (
                    <>
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Skills</div>
                      {skillMatches.map((sk, i) => (
                        <button
                          key={sk.id}
                          role="option"
                          aria-selected={i === menuSel}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${i === menuSel ? 'bg-surface-2' : ''}`}
                          onClick={() => armSkill(sk)}
                          onMouseEnter={() => setMenuSel(i)}
                          title={sk.description}
                        >
                          {sk.highlighted && <span className="text-[12px] text-accent">★</span>}
                          <span className="font-mono text-[13px] text-accent">/{sk.name}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{sk.description}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {slashMatches.length > 0 && (
                    <>
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Prompts</div>
                      {slashMatches.map((p, i) => {
                        const idx = skillMatches.length + i;
                        return (
                          <button
                            key={p.id}
                            role="option"
                            aria-selected={idx === menuSel}
                            className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${idx === menuSel ? 'bg-surface-2' : ''}`}
                            onClick={() => { setDraft(p.body); composerRef.current?.focus(); }}
                            onMouseEnter={() => setMenuSel(idx)}
                          >
                            <span className="font-mono text-[13px] text-accent">/{p.name}</span>
                            <span className="truncate text-[11px] text-ink-faint">{p.body}</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            {/* Recovery is separate from the placeholder suggestion. The wall
                composer shows no "Continue work" box: the window's error banner
                carries Retry when a turn actually stopped. */}
            {!imageMode && surface !== 'composer' && (canContinueReply || canContinueWork) && !streaming && (
              <div className="flex items-center border-b border-line px-3 py-2.5">
                <button
                  className={canContinueReply ? suggestedReplyClassName : 'btn btn-outline py-1 text-[12px]'}
                  title={canContinueReply ? 'Continue this reply, keeping the work already done' : 'Ask the agent to continue any remaining work from this conversation'}
                  onClick={() => canContinueReply ? void resumeRun() : void send('Continue the remaining work from this conversation. Preserve what is already done; if the task is complete or blocked, explain that instead of repeating it.')}
                >
                  {canContinueReply ? 'Retry' : 'Continue work'}
                </button>
              </div>
            )}

                {/* Attachments ride inside the composer, at the top, separated by
                    a hairline. Floated above it they covered the instrument
                    strip. */}
                {pendingImages.length > 0 && (
                  <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-line px-3 py-2.5" data-composer-attachments>
                    {pendingImages.map((image, i) => (
                      <div key={`${image.slice(0, 24)}-${i}`} className="group relative shrink-0">
                        <img
                          src={image}
                          alt={`Pending attachment ${i + 1}`}
                          className="h-16 w-16 cursor-pointer rounded-lg border border-line object-cover"
                          onClick={() => setLightbox(image)}
                          onContextMenu={(e) => openImageMenu(e, image)}
                          title="Click to preview · right-click to copy or save"
                        />
                        <button
                          className="absolute -right-1 -top-1 hidden h-4 w-4 rounded-full bg-ink text-[10px] leading-4 text-paper group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingImages((current) => current.filter((_, index) => index !== i));
                          }}
                          title="Remove image"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {activeSkill && (
                  <div className="flex shrink-0 items-center gap-2 px-3.5 pt-2.5" data-composer-skill>
                    <span className="skill-pill text-[12px]" title={activeSkill.description}>
                      <span className="skill-pill-slash">/</span>{activeSkill.name}
                      <button
                        className="ml-1 opacity-60 hover:opacity-100"
                        onClick={() => setActiveSkill(null)}
                        title="Remove skill"
                      >
                        ×
                      </button>
                    </span>
                    <span className="truncate text-[11px] text-ink-faint">
                      Runs on send · shown in context →
                    </span>
                  </div>
                )}
                <div className="composer-editor-wrap relative">
                  {/* The → badge announces the ghost-accept key, top-right in the
                      textarea's padding so it never overlaps the text. */}
                  {ghostSuggestion && (
                    <span
                      className="pointer-events-none absolute right-3 top-3 z-10 select-none rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-faint"
                      aria-hidden
                    >
                      →
                    </span>
                  )}
                  <MarkdownEditor
                    ref={composerRef}
                    className={`relative ${compact ? 'min-h-[36px] py-2' : 'min-h-[52px] py-3'} w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-3.5 text-sm text-ink caret-ink outline-hidden [scrollbar-gutter:stable] empty:before:content-[attr(data-placeholder)] empty:before:text-ink-faint`}
                    placeholder={imageMode ? 'Describe the image you want…' : streaming ? 'Queue a follow-up… (Ctrl/⌘+Enter steers the running reply)' : ghostSuggestion ?? (hasProvider ? 'Message Nekko Agent…  (/ for prompts, @ to attach files)' : 'Add a model provider in Model Providers first')}
                    value={draft}
                    aria-expanded={slashMenuOpen || atMenuOpen}
                    aria-controls={slashMenuOpen ? `slash-menu-${sessionId}` : atMenuOpen ? `at-menu-${sessionId}` : undefined}
                    onChange={(text) => { setDraft(text); setMenuClosed(false); }}
                    onPaste={imageMode ? undefined : onPaste}
                    onKeyDown={onComposerKeyDown}
                    disabled={!canCompose}
                  />
                  <ComposerFocus target={composerRef} sessionId={sessionId} ready={providers.length} />
                </div>
                <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                  {!imageMode && (<>
                  <div
                    ref={attachMenuRef}
                    className="relative"
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape' || !attachMenuOpen) return;
                      e.stopPropagation();
                      // Escape closes the skills flyout first, then the menu.
                      if (skillsHover) { setSkillsHover(false); }
                      else closeAttachMenu(true);
                    }}
                  >
                    <button
                      ref={attachButtonRef}
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
                      onClick={() => (attachMenuOpen ? closeAttachMenu() : setAttachMenuOpen(true))}
                      title="Add a photo, file, folder, or skill"
                      aria-label="Add a photo, file, folder, or skill"
                      aria-haspopup="menu"
                      aria-expanded={attachMenuOpen}
                    >
                      <PlusIcon className="h-4 w-4" />
                    </button>
                    {attachMenuOpen && (
                      <div className="card absolute bottom-full left-0 z-40 mb-2 w-48 p-1.5 shadow-lg" role="menu">
                        <button
                          role="menuitem"
                          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
                          onClick={() => { closeAttachMenu(); imageInputRef.current?.click(); }}
                          onMouseEnter={closeSkillsFly}
                        >
                          Photo
                        </button>
                        <button
                          role="menuitem"
                          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
                          onClick={() => { closeAttachMenu(); void addFiles(); }}
                          onMouseEnter={closeSkillsFly}
                        >
                          File
                        </button>
                        <button
                          role="menuitem"
                          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
                          onClick={() => {
                            closeAttachMenu();
                            const chat = useStore.getState().sessions.find((x) => x.id === sessionId) ?? session;
                            addFolderToChat(sessionId, chat, 'include')
                              .then((s) => { if (s) setSession(s); })
                              .catch((e) => useStore.getState().pushToast('error', String(e)));
                          }}
                          onMouseEnter={closeSkillsFly}
                        >
                          Folder
                        </button>
                        {/* Skills expand as a side flyout on hover, so someone new
                            finds them without knowing to type `/` or to click. */}
                        <div className="my-1 border-t border-line" />
                        <div className="relative" onMouseEnter={openSkillsFly} onMouseLeave={closeSkillsFly}>
                          <button
                            role="menuitem"
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] ${skillsHover ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                            onClick={() => setSkillsHover((v) => !v)}
                            onFocus={openSkillsFly}
                            aria-haspopup="menu"
                            aria-expanded={skillsHover}
                          >
                            <span className="flex-1">Skill</span>
                            {allSkills.length > 0 && (
                              <span className="tabular-nums text-[11px] text-ink-faint">{allSkills.length}</span>
                            )}
                            <span className="text-[10px] text-ink-faint">&#9656;</span>
                          </button>
                          {skillsHover && (
                            <div
                              className="card absolute bottom-0 left-full z-50 ml-1.5 w-72 p-1.5 shadow-lg"
                              role="menu"
                              aria-label="Skills"
                              onMouseEnter={openSkillsFly}
                              onMouseLeave={closeSkillsFly}
                            >
                              <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">Skills</div>
                              <div className="max-h-64 overflow-y-auto">
                                {allSkills.length === 0 && (
                                  <p className="px-2.5 py-2 text-[11px] text-ink-faint">
                                    No skills registered yet. Add one to run it from any chat.
                                  </p>
                                )}
                                {allSkills.map((sk) => (
                                  <button
                                    key={sk.id}
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                                    onClick={() => { closeAttachMenu(); armSkill(sk); }}
                                    title={sk.description}
                                  >
                                    {sk.highlighted && <span className="shrink-0 text-[12px] text-accent">&#9733;</span>}
                                    <span className="shrink-0 font-mono text-[12px] text-accent">/{sk.name}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{sk.description}</span>
                                  </button>
                                ))}
                              </div>
                              <div className="mt-1 border-t border-line pt-1">
                                <button
                                  role="menuitem"
                                  className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-accent hover:bg-surface-2"
                                  onClick={() => { closeAttachMenu(); useStore.getState().setView('skills'); }}
                                >
                                  <PlusIcon className="h-3.5 w-3.5" /> Add skill
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <input
                      ref={imageInputRef}
                      className="hidden"
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length) void addImages(files);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  </>)}
                  {header && (
                    <div className="composer-foot-controls flex min-w-0 items-center gap-1" data-composer-foot>
                      <ChatControls session={session} isCloudModel={isCloudModel} onChange={setSession} toolsInWindow only="mode" />
                      <ChatControls session={session} isCloudModel={isCloudModel} onChange={setSession} toolsInWindow only="privacy" />
                    </div>
                  )}
                  <div className="flex-1" />
                  {streaming && <button className="btn btn-outline h-8 px-3 py-0 text-[12px]" onClick={() => window.nekko.abortChat(sessionId)}>Stop</button>}
                  {/* Prompt suggestions: one chip beside the microphone; its
                      details open above it rather than pushing the editor. */}
                  {!imageMode && (
                    <PromptAnalyzer
                      variant="chip"
                      text={deferredDraft}
                      sessionId={sessionId}
                      canModelFill={hasProvider}
                      workspaces={settings?.workspaces ?? []}
                      contextItems={ctx?.items ?? []}
                      activeWorkspaceIds={session ? getSessionWorkspaceIds(session) : []}
                      onFill={({ snippet, placement }) => {
                        setDraft((d) =>
                          placement === 'start' ? `${snippet}\n\n${d.replace(/^\s+/, '')}` : `${d.replace(/\s+$/, '')}\n\n${snippet}`,
                        );
                        composerRef.current?.focus();
                      }}
                    />
                  )}
                  <DictationButton key={sessionId} sessionId={sessionId} onText={(text) => { setDraft((current) => current + (current && !/\s$/.test(current) ? ' ' : '') + text); composerRef.current?.focus(); }} />
                    <button
                      className="send-avatar grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-all duration-150 disabled:opacity-40"
                      onClick={() => void send()}
                      disabled={imageMode ? streaming || !draft.trim() : (!draft.trim() && pendingImages.length === 0 && !activeSkill) || !hasProvider}
                      title={streaming ? 'Add to queue after this reply' : 'Send'}
                      aria-label={streaming ? 'Add to queue' : 'Send'}
                    >
                      <NekkoAvatar size={24} />
                    </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        )}
        {/* In the wall composer this strip only carries the PR dock (the model,
            folder and usage controls live in the agent window), so it draws no
            chrome of its own: empty, it used to show as a bare band under the
            composer. */}
        <div className={surface === 'composer' ? 'shrink-0' : 'shrink-0 border-t border-line bg-surface px-3 py-1.5'} aria-label="Chat actions and information">
          <PrActionDock key={sessionId} sessionId={sessionId} prs={prs} urls={sessionPrUrls} />
          {/* Said once, next to the control that fixes it, in the window being driven. */}
          {modelHint && !imageMode && surface !== 'composer' && <p role="status" data-model-note className="mb-1.5 flex items-center gap-1.5 text-[11.5px]" style={{ color: unavailableModel ? 'var(--warning)' : 'var(--accent)' }}><span aria-hidden>●</span>{modelHint}</p>}
          {!imageMode && surface !== 'composer' && <div className="flex flex-wrap items-center gap-2">
                  <FolderPicker sessionId={sessionId} session={session} disabled={hasLive} onChange={setSession} />
                  {modelControls}
                  <>
                  <LiveContextGauge
                    sessionId={sessionId}
                    marks={marks}
                    bundle={ctx}
                    skill={skillTokens}
                    draftTokens={deferredDraft.trim() ? estimateTokens(deferredDraft) : 0}
                    contextWindow={selectedModelInfo?.contextLength}
                    windowReported={!!selectedModelInfo?.contextLength}
                  />
                  <LiveUsageChip
                    sessionId={sessionId}
                    marks={marks}
                    measured={turnCostMeasured}
                    pendingIn={pendingIn}
                    model={modelForCostRef.current}
                    provider={activeProvider}
                    session={session ?? undefined}
                    cost={cost}
                    avoidedCosts={avoidedCosts}
                    running={streaming}
                    unpriced={!!avoidedCosts?.unpricedTokens || (streaming && !getModelPrice(modelForCostRef.current ?? undefined))}
                  />
                  </>
            {/* What this agent may reach and use, then its status in the far
                bottom-right corner of the window. */}
            <div className="agent-footer-reach ml-auto flex shrink-0 items-center gap-1" data-agent-footer-controls>
              {session && <>
                <ToolsMenu session={session} onChange={setSession} />
                {session?.executionMode === 'sandbox' ? <span className="text-[11px] text-ink-faint">MCP unavailable in Sandbox</span> : <McpMenu />}
              </>}
              <InternetToggle session={session} cloudModel={isCloudModel} onToggle={() => { void window.nekko.setSessionOptions(sessionId, { offline: !session?.offline }).then(setSession).catch(e => useStore.getState().pushToast('error', String(e))); }} />
              {status && <span className="agent-footer-status ml-1 inline-flex items-center" data-agent-status><StatusIcon status={status === 'idle' ? undefined : status} /></span>}
            </div>
          </div>}
          {/* An image chat runs no agent, so no tools or internet switch: just its status. */}
          {imageMode && surface !== 'composer' && status && <div className="flex items-center justify-end"><span className="agent-footer-status inline-flex items-center" data-agent-status><StatusIcon status={status === 'idle' ? undefined : status} /></span></div>}
        </div>
      </section>

      {/* The work rail, in the quarter the transcript gives back. Kept inside
          the chat pane (not the workbench's right panel) because everything in
          it belongs to this one conversation. */}
      {surface !== 'composer' && planRailOpen && (
        <div className="shrink-0" style={{ width: PLAN_RAIL_WIDTH }}>
          <PlanRail
            sessionId={sessionId}
            session={session}
            streaming={streaming}
            onChangePlan={readOnly ? undefined : () => {
              setDraft(appendPlanChangeRequest);
              composerRef.current?.focus();
            }}
          />
        </div>
      )}

      {scheduleOpen && (
        <ScheduleTaskModal
          workspaceId={session?.workspaceId}
          providerId={providerId ?? undefined}
          modelId={modelId && modelId !== AUTO_MODEL_ID ? modelId : undefined}
          initialPrompt={draft.trim() || undefined}
          onClose={() => setScheduleOpen(false)}
        />
      )}
      {lightbox && (
        <Modal
          title="Attached image"
          onClose={() => setLightbox(null)}
          scrim="rgba(0,0,0,0.5)"
          overlayClassName="p-4"
        >
          <div className="flex max-h-[calc(100vh-2rem)] max-w-[90vw] flex-col items-center gap-3" onClick={() => setLightbox(null)}>
            <button
              className="flex min-h-11 items-center gap-2 self-end rounded-full bg-surface px-4 py-2 text-[14px] font-medium text-ink shadow-lg hover:bg-surface-2"
              aria-label="Close image"
              onClick={() => setLightbox(null)}
            >
              <CloseIcon className="h-5 w-5" /> Close
            </button>
            <img
              src={lightbox}
              alt="Full-size attachment"
              className="block max-h-[calc(100vh-6rem)] max-w-full object-contain"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => openImageMenu(e, lightbox)}
              title="Right-click to copy or save"
            />
          </div>
        </Modal>
      )}
      {imageMenu && (
        <ImageMenu x={imageMenu.x} y={imageMenu.y} src={imageMenu.src} onClose={() => setImageMenu(null)} />
      )}
    </div>
    </MarkdownSandbox.Provider>
  );
}

/**
 * What sits where the composer would, in an archived chat: when it goes, and
 * the two ways out. Delete forever asks first, since it is the one action in
 * the archive that cannot be taken back.
 */
function ArchivedChatBar({ sessionId, contentWidth, archivedAt }: { sessionId: string; contentWidth: string; archivedAt: number | null }) {
  const restoreChat = useStore((s) => s.restoreChat);
  const deleteChatForever = useStore((s) => s.deleteChatForever);
  const [busy, setBusy] = useState(false);
  const days = archivedAt ? archiveDaysLeft(archivedAt) : null;
  return (
    <div className="border-t border-line px-4 py-3">
      <div className={`${contentWidth} flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5`} style={{ background: 'var(--surface-2)' }}>
        <CheckIcon className="h-4 w-4 shrink-0 text-ink-faint" />
        <p className="min-w-0 flex-1 text-[12px] text-ink-soft">
          Completed and read-only.
          {days !== null && (
            <span className="text-ink-faint"> {days === 0 ? 'Deleted today' : `Deleted in ${days} day${days === 1 ? '' : 's'}`} unless restored.</span>
          )}
        </p>
        <button
          className="btn btn-outline h-8 px-3 py-0 text-[12px] text-(--danger)"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm('Delete this chat forever? It cannot be recovered.')) return;
            setBusy(true);
            await deleteChatForever(sessionId);
            setBusy(false);
          }}
        >
          <TrashIcon className="h-3.5 w-3.5" /> Delete forever
        </button>
        <button
          className="btn btn-primary h-8 px-3 py-0 text-[12px]"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await restoreChat(sessionId);
            setBusy(false);
          }}
        >
          <UndoIcon className="h-3.5 w-3.5" /> Restore chat
        </button>
      </div>
    </div>
  );
}

/** Memoized: the workspace around a chat re-renders for its own reasons (a status dot, a sidebar card); the chat does not follow. */
export const ChatPane = memo(ChatPaneImpl);
