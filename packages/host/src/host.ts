import { assertHostExecution } from './indirect-execution-guard.js';
import { configureSandbox, sandboxStatus, sandboxDiff, applySandboxDiff, cleanupSandbox } from './execution-router.js';
import { resourceQueue } from './resource-queue.js';
import { EventEmitter } from 'events';
import { basename, resolve } from 'path';
import type {
  AppSettings,
  AskAnswer,
  PendingInput,
  ProviderConfig,
  ModelInfo,
  ModelFacts,
  FitPlan,
  FitRequest,
  RuntimeStatus,
  StopResult,
  LoadParams,
  LoadResult,
  Session,
  SessionSummary,
  SendOptions,
  OAuthProvider,
  OAuthSessionInfo,
  OAuthStatus,
  ContextBundle,
  MemoryEntry,
  MemoryScope,
  WorkspaceFolder,
  IndexStatus,
  SearchHit,
  IndexedFile,
  GitStatus,
  ChatWorktreeInfo,
  DirEntry,
  FileContent,
  FileChange,
  PrInfo,
  PrDiff,
  PrAction,
  PrActionResult,
  LineComment,
  DesignBoard,
  DesignPage,
  GenerateDesignInput,
  AutomationTask,
  NewTask,
  TrainingRun,
  NewTrainingRun,
  Workflow,
  NewWorkflow,
  WorkflowEvent,
  WorkflowRun,
  WorkflowsSnapshot,
  InstalledSkillRecord,
  InstallTargetInfo,
  InstallTarget,
  ConnectorConfig,
  ConnectorKind,
  ConnectorResource,
  AgentToolId,
  AgentToolStatus,
  SubagentInstallResult,
  SubagentSnippet,
  SubagentTarget,
  GuardrailDecision,
  UsageSummary,
  RemoteStatus,
  AppInfo,
  McpServerStatus,
  SpecDocStatus,
  TerminalInfo,
  TerminalSnapshot,
  ShellOption,
  GpuStats,
  SystemStats,
  LmsProbe,
  SubscriptionLimits,
  ReadinessReport,
  AutoFitSummary,
  QueuePayload,
  CatalogModel,
  CatalogModelDetail,
  DownloadJob,
  EngineLoadPreset,
  EngineSettings,
  EngineStatus,
  LocalModel,
  ModelFolder,
  ModelFolderReport,
  SkillDef,
} from '@nekko-agent/shared';
import { AUTO_MODEL_ID, brandEnv, DEFAULT_ENGINE_SETTINGS, engineBaseUrl, isLocalProvider, isRuntimeKind, queueItemPayload, SKILLS, sameFolderPath } from '@nekko-agent/shared';
import { gatherMachineFacts } from './readiness.js';
import { createRuntimes } from './runtimes/index.js';
import { createEngine } from './engine/index.js';
import { daemonCall } from './engine/daemon.js';
import { registerManagedCacheEndpoint } from './prompt-caching.js';
import {
  createProvider,
  discoverLocalProviders,
  OllamaProvider,
  getConnector,
  classifyCommand,
  BUILTIN_TOOLS,
  evaluateReadiness,
  OFFLINE_STACK_CATALOG,
} from '@nekko-agent/core';
import { setDataDir, dataDir } from './paths.js';
import { createVoiceService } from './engine/voice.js';
import { join } from 'node:path';
import { getSettings, saveSettings, resetSettings } from './store.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import { usageSummary, clearUsage } from './usage.js';
import { indexWorkspace, getIndexStatus, searchWorkspace, listIndexedFiles } from './workspace.js';
import { readFile, writeFile, listDir } from './files.js';
import { getGitStatus } from './git.js';
import { listChanges, acceptChange, acceptAllChanges, notifyChanges, setChangeNotifier } from './changes.js';
import { listSessionPrs, getPrDiff, prAction, fetchPrInfo } from './pr.js';
import { configureAgentWatches, nextAgentWatchAt } from './agent-watches.js';
import { listComments, addComment, resolveComment } from './comments.js';
import {
  getDesignBoard,
  addDesignPage,
  updateDesignPage,
  removeDesignPage,
  addDesignNote,
  resolveDesignNote,
  generateDesign,
} from './design.js';
import { listInstalledSkills, skillTargets, installSkill, uninstallSkill, listInstalledSkillDefs } from './skills.js';
import { discoverExternalSkills } from './external-skills.js';
import { getVaizerCatalog, getVaizerSkillMd } from './vaizer.js';
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  runTaskNow,
  setTaskSender,
  setTasksNotifier,
  startTaskScheduler,
} from './tasks.js';
import {
  listTrainingRuns,
  createTrainingRun,
  updateTrainingRun,
  deleteTrainingRun,
  startTrainingRun,
  pauseTrainingRun,
  stopTrainingRun,
  addTrainingHint,
  setTrainingSender,
  setTrainingNotifier,
  startTrainingScheduler,
} from './training.js';
import {
  listWorkflowRuns,
  workflowsSnapshot,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  runWorkflow,
  cancelWorkflowRun,
  dispatchWorkflowEvent,
  dispatchWebhook,
  setWorkflowSender,
  setWorkflowsNotifier,
  startWorkflowScheduler,
  reconcileWorkflowRuns,
} from './workflows.js';
import { listChatWorktrees, removeChatWorktree } from './chat-worktrees.js';
import { isChatRunning, reconcileInterruptedChats, setDecisionRunner, sendChat, abortChat, steerChat, suggestReplies, fillPromptPart, getPendingInput, getHostPendingInput, getRunningSessionIds, resolveApproval, answerQuestion, previewContext, setContextPrefs } from './chat.js';
import { abortImageTurn, generateImageTurn, sessionImages } from './image-chat.js';
import { loopApprove, loopEnd, loopEvent, loopLog, loopTool } from './daemon-loop.js';
import { setTurnNotifier, turnCallback } from './daemon-turn.js';
import { compactSession, cancelSessionCompaction, isSessionCompacting, setCompactionSender } from './compaction.js';
import { initLimits, getLimits, clearLimits, getLimitsProblem } from './limits.js';
import { startWorkflowListeners } from './listeners.js';
import {
  initOAuth,
  beginOAuth,
  finishOAuth,
  cancelOAuth,
  getOAuthStatus,
  signOut as signOutOAuth,
  importCliAuth,
  resolveSubscriptionProvider,
} from './oauth.js';
import { buildSpec, buildSpecDoc, readSpecDocs, setSpecMethodology, toggleSpecTask, specPathForSession } from './spec.js';
import { createRemoteService } from './remote.js';
import { createMessagingService } from './messaging/service.js';
import { detectAgentTools, installSubagent, refreshSubagent, subagentSnippet } from './integrations.js';
import { getGpuStats, getGpuStatsFresh } from './gpu.js';
import { startUpdateChecks } from './update-checks.js';
import { detectGpuAdapters } from './gpu-adapters.js';
import { getSystemStats } from './system.js';
import { stopLocalServer } from './servers.js';
import { lmsProbe, lmsLoad, lmsUnload } from './lms.js';
import { syncMcp, mcpStatus, mcpToolList, detectHypergate, resolveHypergate, withHypergate } from './mcp.js';
import {
  setTerminalSender,
  listTerminals,
  listShells,
  createTerminal,
  terminalSnapshot,
  writeTerminal,
  resizeTerminal,
  runInTerminal,
  signalTerminal,
  closeTerminal,
  updateTerminal,
} from './terminal.js';
import { randomUUID } from 'crypto';

/**
 * The transport-agnostic host. `createHost()` returns an object implementing the
 * full NekkoApi surface (sans the renderer-side `on*` subscriptions, which are
 * served by `events`) plus a couple of methods the UI layer drives differently
 * per runtime (e.g. `addWorkspaceByPath`, since Electron uses a native dialog
 * while the web server takes a path string).
 *
 * Every edition, Electron, the web server, Nekko Agent Cloud, wraps the same Host.
 */
export interface Host {
  /** Emits 'agentEvent' (AgentEvent) and 'indexProgress' (IndexStatus). */
  readonly events: EventEmitter;
  dataDir(): string;

  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;

  listProviders(): ProviderConfig[];
  saveProvider(p: ProviderConfig): ProviderConfig[];
  removeProvider(id: string): ProviderConfig[];
  discoverProviders(): Promise<ProviderConfig[]>;
  /** Probe localhost for running model servers without persisting (onboarding). */
  probeProviders(): Promise<ProviderConfig[]>;
  testProvider(id: string): Promise<{ ok: boolean; message: string }>;
  testProviderConfig(cfg: ProviderConfig): Promise<{ ok: boolean; message: string }>;

  listModels(providerId: string): Promise<ModelInfo[]>;
  pullModel(providerId: string, model: string): Promise<{ ok: boolean; message: string }>;
  loadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  unloadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  /** Whether per-model load/unload is available for an LM Studio provider (via `lms`). */
  lmsAvailable(providerId: string): Promise<LmsProbe>;
  runtimeStatus(providerId: string): Promise<RuntimeStatus | null>;
  runtimeStart(providerId: string): Promise<RuntimeStatus | { error: string }>;
  runtimeStop(providerId: string, force?: boolean): Promise<StopResult>;
  runtimeLoad(providerId: string, modelId: string, params: LoadParams): Promise<LoadResult>;
  runtimeFacts(providerId: string): Promise<ModelFacts[]>;
  runtimePlan(providerId: string, modelId: string, req: FitRequest): Promise<FitPlan | null>;
  runtimeAutoFit(
    providerId: string,
    modelId: string,
    budgetFraction: number,
    parallelSlots?: number,
  ): Promise<AutoFitSummary | null>;

  /** The built-in engine: install, catalog, library, and its own server. */
  voiceStatus(): Promise<import('@nekko-agent/shared').VoiceStatus>;
  voiceInstall(): Promise<import('@nekko-agent/shared').VoiceStatus>;
  voiceCancelInstall(): Promise<void>;
  voiceUninstall(): Promise<void>;
  voiceTranscribe(wav: number[]): Promise<string>;
  engineStatus(): Promise<EngineStatus>;
  /** For the engine daemon's router: load a model it was asked for, or say why not. */
  engineRouterLoad(modelId: string, image: boolean): Promise<{ ok: boolean; status?: number; message?: string }>;
  /** A daemon-driven run's callbacks (daemon-loop.ts): a tool call, its events, its end. */
  loopTool(runId: string, call: import('@nekko-agent/shared').ToolCall): Promise<import('@nekko-agent/shared').ToolResult>;
  loopEvent(runId: string, payload: { events?: import('@nekko-agent/shared').AgentEvent[]; history?: import('@nekko-agent/shared').ChatMessage[] }): Promise<void>;
  loopEnd(runId: string, payload: { history?: import('@nekko-agent/shared').ChatMessage[] }): void;
  loopApprove(runId: string, call: import('@nekko-agent/shared').ToolCall, reason: string, severity: 'low' | 'medium' | 'high'): Promise<boolean>;
  loopLog(sessionId: string, workspaceId: string | undefined, data: string): void;
  /** A daemon-driven chat turn's callbacks (daemon-turn.ts `turn:*`). */
  turnCallback(channel: string, args: unknown[]): Promise<unknown>;
  changesNotify(sessionId: string): void;
  /** For the engine daemon's router: `GET /v1/models`. */
  engineRouterModels(): Promise<unknown>;
  engineRouterModel(modelId: string): Promise<unknown>;
  engineInstall(buildId?: string, runtime?: 'llama' | 'diffusion' | 'mlx'): Promise<{ ok: boolean; message: string; jobId?: string }>;
  engineInstallPreview(runtime: 'llama' | 'diffusion' | 'mlx', buildId?: string): Promise<import('@nekko-agent/shared').EngineInstallPreview | null>;
  engineGenerateImage(request: import('@nekko-agent/shared').ImageGenerationRequest): Promise<import('@nekko-agent/shared').ImageGenerationResult>;
  engineUninstall(runtime?: 'llama' | 'diffusion' | 'mlx'): Promise<{ ok: boolean; message: string }>;
  engineSettingsSave(patch: Partial<EngineSettings>): Promise<EngineSettings>;
  engineModels(): Promise<Array<LocalModel & { loaded: boolean; gpuFit?: import('@nekko-agent/shared').GpuFit }>>;
  engineImportModel(path: string): Promise<{ ok: boolean; message: string; model?: LocalModel }>;
  engineDeleteModel(id: string): Promise<{ ok: boolean; message: string }>;
  engineSaveModelPreset(id: string, preset: EngineLoadPreset): Promise<void>;
  engineCatalog(query?: string, format?: 'gguf' | 'mlx'): Promise<CatalogModel[]>;
  engineCatalogModel(id: string): Promise<CatalogModel | null>;
  engineCatalogDetail(id: string): Promise<CatalogModelDetail | null>;
  /** Where the library looks for models, plus known folders nobody has added. */
  engineFolders(): Promise<ModelFolderReport>;
  engineFoldersSave(folders: ModelFolder[]): Promise<ModelFolderReport>;
  engineDownloadModel(modelId: string, quantLabel: string): Promise<{ ok: boolean; message: string; jobId?: string }>;
  /** Fetch a resident-or-not model's missing companions (projector, configs). */
  engineDownloadCompanions(modelId: string): Promise<{ ok: boolean; message: string }>;
  engineImageCompanions(modelId: string): Promise<import('@nekko-agent/shared').ImageCompanionStatus | null>;
  engineDownloadImageCompanions(modelId: string): Promise<{ ok: boolean; message: string }>;
  decisionsCatalog(): Promise<import('@nekko-agent/shared').DecisionCatalogEntry[]>;
  decisionsModels(): Promise<import('@nekko-agent/shared').InstalledDecisionModel[]>;
  decisionsDownload(catalogId: string, precision?: import('@nekko-agent/shared').DecisionPrecision): Promise<{ ok: boolean; message: string }>;
  decisionsDelete(id: string): Promise<{ ok: boolean; message: string }>;
  decisionsAddFolder(path: string): Promise<{ ok: boolean; message: string }>;
  decisionsStatus(): Promise<import('@nekko-agent/shared').DecisionStatus>;
  decisionsLoad(id: string, precision?: import('@nekko-agent/shared').DecisionPrecision): Promise<{ ok: boolean; message: string }>;
  decisionsUnload(): Promise<{ ok: boolean; message: string }>;
  decisionsRun(provider: import('@nekko-agent/shared').DecisionProvider, request: import('@nekko-agent/shared').DecisionRequest): Promise<import('@nekko-agent/shared').DecisionResponse>;
  decisionsCheckTypesafe(): Promise<{ ok: boolean; message: string }>;
  /** Set a resident model's idle TTL in seconds (0 keeps it loaded). */
  engineSetResidentTtl(modelId: string, ttlSeconds: number): Promise<{ ok: boolean; message: string }>;
  /** Add or remove a model from the list loaded when the engine starts. */
  engineSetAutoload(modelId: string, enabled: boolean): Promise<EngineSettings>;
  engineDownloads(): Promise<DownloadJob[]>;
  engineCancelDownload(id: string): Promise<void>;
  engineDismissDownload(id: string): Promise<void>;
  /**
   * The AN9b machine-readiness report: probe this machine and evaluate it
   * against the versioned offline-stack catalog (runtime + intent + STT + TTS).
   */
  machineReadiness(language?: string): Promise<ReadinessReport>;
  /** Stop the local model server backing a provider (kills its listening process). */
  stopServer(providerId: string): Promise<{ ok: boolean; message: string }>;
  /** GPU stats from the platform's probe (null when it can't read one). */
  getGpuStats(): Promise<GpuStats | null>;
  /** CPU load + RAM use for the resource monitors. */
  getSystemStats(): Promise<SystemStats | null>;

  listSessions(): Session[];
  nextAgentWatchAt(sessionId: string): number | null;
  /** Every chat without its transcript, from a cache that re-reads only changed files. */
  listSessionSummaries(): Promise<SessionSummary[]>;
  configureSandbox(sessionId: string, image: string): Promise<import('@nekko-agent/shared').SandboxStatus>;
  cleanupSandbox(sessionId: string, identity: string): Promise<void>;
  sandboxStatus(sessionId: string): import('@nekko-agent/shared').SandboxStatus;
  sandboxDiff(sessionId: string): Promise<import('@nekko-agent/shared').SandboxDiff>;
  applySandboxDiff(sessionId: string, identity: string, diffId: string, paths: string[]): Promise<never>;
  createSession(workspaceId?: string): Session;
  getSession(id: string): Session | null;
  deleteSession(id: string): void;
  setSessionWorkspace(id: string, workspaceId?: string): Session | null;
  setSessionSupportingWorkspaces(id: string, workspaceIds: string[]): Session | null;
  setSessionAttachments(id: string, paths: string[]): Session | null;
  sendChat(opts: SendOptions): Promise<void>;
  generateImageTurn(opts: import('@nekko-agent/shared').ImageTurnOptions): Promise<void>;
  sessionImages(sessionId: string, limit: number): Array<{ messageId: string; src: string }>;
  abortChat(sessionId: string): void;
  compactSession(sessionId: string, opts?: { newChat?: boolean } | null): Promise<Session>;
  cancelSessionCompaction(sessionId: string): void;
  queuePrompt(sessionId: string, input: string | QueuePayload): Session | null;
  dequeuePrompt(sessionId: string, index: number): Session | null;
  steerChat(sessionId: string, text: string): Promise<Session | null>;
  interruptQueuedPrompt(sessionId: string, index: number, brain?: { providerId: string; modelId: string }): Promise<void>;
  /**
   * Model-written next-step ideas for a chat's last reply: one-click follow-up
   * chips plus the ghost-text draft. Sideband, unpersisted; null when there's
   * nothing to suggest from.
   */
  resourceQueue(action: string, input?: Record<string, unknown>): Promise<unknown>;
  suggestReplies(sessionId: string): Promise<import('@nekko-agent/shared').ReplySuggestions | null>;
  /**
   * Model-drafted fill for a missing prompt part (analyzer click-to-fill).
   * Sideband, unpersisted; null falls back to the deterministic snippet.
   */
  fillPromptPart(sessionId: string, part: string, draft: string): Promise<string | null>;
  approveTool(sessionId: string, toolCallId: string, approved: boolean): void | Promise<void>;
  /** Answer an `ask_user` call; an empty list means "not answering". */
  answerQuestion(sessionId: string, callId: string, answers: AskAnswer[]): void | Promise<void>;
  /** Every session waiting on a person right now, keyed by session id (this process's turns and the engine daemon's). */
  pendingInput(): Promise<Record<string, PendingInput>>;
  /** Only this process's turns (`chat:pending:host`, for the daemon, which merges its own). */
  hostPendingInput(): Record<string, PendingInput>;
  runningSessions(): string[];

  listTerminals(): Promise<TerminalInfo[]>;
  listShells(): ShellOption[];
  createTerminal(opts?: { workspaceId?: string; sessionId?: string; cwd?: string; title?: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalInfo>;
  terminalSnapshot(id: string): Promise<TerminalSnapshot | null>;
  updateTerminal(id: string, patch: { workspaceId?: string | null; order?: number; title?: string }): Promise<void>;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  runInTerminal(id: string, command: string): void;
  signalTerminal(id: string, signal: 'interrupt'): void;
  closeTerminal(id: string): void;

  previewContext(sessionId: string, attachedPaths: string[]): Promise<ContextBundle>;
  setContextPrefs(sessionId: string, prefs: { excluded: string[]; pinned: string[] }): void;

  buildSpec(sessionId: string): Promise<{ ok: boolean; path?: string; message?: string }>;
  buildSpecDoc(sessionId: string, docId?: string, workspaceId?: string): Promise<{ ok: boolean; path?: string; docId?: string; message?: string }>;
  readSpecDocs(sessionId: string, workspaceId?: string): { methodologyId: string; docs: SpecDocStatus[] };
  setSpecMethodology(sessionId: string, methodologyId: string): void;
  toggleSpecTask(sessionId: string, lineIndex: number, workspaceId?: string): { ok: boolean; message?: string };
  setSpecLinked(sessionId: string, linked: boolean): Session | null;
  specPath(sessionId: string): string | null;
  setSessionOptions(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'mode' | 'disabledTools' | 'offline' | 'incognito' | 'executionMode' | 'gitIsolation' | 'autoModel' | 'autoQuality' | 'autoProviderSwitch' | 'thinking' | 'providerId' | 'modelId' | 'plan' | 'chatType' | 'imageParams' | 'archivedAt'>>,
  ): Session | null;
  truncateSession(id: string, messageId: string): Session | null;
  clearSessions(scope: 'today' | 'month' | 'all'): number;
  /** Delete archived chats past the retention window; returns how many went. */
  purgeExpiredArchives(): number;
  /** A new chat with this one's conversation before a message (see sessions.forkSession). */
  forkSession(id: string, beforeMessageId?: string): Session | null;
  resetSettings(): AppSettings;
  wipeAllData(): AppSettings;
  listTools(): Array<{ name: string; description: string }>;

  listMemory(scope: MemoryScope, workspaceId?: string): MemoryEntry[];
  saveMemory(entry: MemoryEntry): MemoryEntry[];
  deleteMemory(id: string): void;

  listWorkspaces(): WorkspaceFolder[];
  addWorkspaceByPath(path: string): WorkspaceFolder[];
  removeWorkspace(id: string): WorkspaceFolder[];
  indexWorkspace(id: string): IndexStatus;
  getIndexStatus(id: string): IndexStatus | null;
  searchWorkspace(id: string, query: string): SearchHit[];
  listFiles(id: string): IndexedFile[];
  /** Branch, dirt, and upstream drift for a workspace folder (see git.ts). */
  getGitStatus(id: string, force?: boolean): Promise<GitStatus>;
  listChatWorktrees(): ChatWorktreeInfo[];
  removeChatWorktree(root: string): { branchDeleted: boolean };

  readFile(path: string): FileContent;
  writeFile(path: string, content: string): void;
  listDir(path: string): DirEntry[];

  /** Files the agent changed this session (for diff/approve). */
  listChanges(sessionId: string): Promise<FileChange[]>;
  /** Keep a file's changes, stop tracking it. */
  acceptChange(sessionId: string, path: string): Promise<void>;
  /** Keep all of a session's changes. */
  acceptAllChanges(sessionId: string): Promise<void>;

  /** Live PR state for every PR URL referenced in a chat's transcript. */
  listSessionPrs(sessionId: string): Promise<PrInfo[]>;
  /** A PR's changed files + patches (diff pane). */
  getPrDiff(url: string): Promise<PrDiff>;
  /** Approve / decline / merge / reopen a PR (user-initiated). */
  prAction(url: string, action: PrAction): Promise<PrActionResult>;

  /** Inline editor comments on a file. */
  listComments(path: string): LineComment[];
  addComment(path: string, line: number, lineText: string, comment: string): LineComment[];
  resolveComment(path: string, id: string): LineComment[];

  /** Design board: a workspace's UI page snapshots + persistent notes. */
  getDesignBoard(workspaceId: string): DesignBoard;
  addDesignPage(workspaceId: string, label: string, url: string): DesignBoard;
  updateDesignPage(workspaceId: string, pageId: string, patch: Partial<Pick<DesignPage, 'label' | 'url' | 'html'>>): DesignBoard;
  removeDesignPage(workspaceId: string, pageId: string): DesignBoard;
  addDesignNote(workspaceId: string, pageId: string, text: string): DesignBoard;
  resolveDesignNote(workspaceId: string, pageId: string, noteId: string): DesignBoard;
  generateDesign(workspaceId: string, input: GenerateDesignInput): Promise<DesignBoard>;

  /** Skills marketplace installs. */
  listInstalledSkills(): InstalledSkillRecord[];
  listExternalSkills(): SkillDef[];
  skillTargets(): InstallTargetInfo[];
  installSkill(
    skillId: string,
    target: InstallTarget,
    payload?: import('@nekko-agent/shared').MarketplaceSkill,
  ): { ok: boolean; message?: string; installed: InstalledSkillRecord[] };
  uninstallSkill(skillId: string, target: InstallTarget): InstalledSkillRecord[];
  /** Vaizer skills hub (optional): catalog + a skill's SKILL.md. */
  vaizerCatalog(refresh?: boolean): Promise<import('@nekko-agent/shared').VaizerCatalog>;
  vaizerSkillMd(slug: string): Promise<string | null>;

  /** Automation tasks: scheduled, recurring, and long-running background agents. */
  listTasks(): AutomationTask[];
  createTask(task: NewTask): AutomationTask[];
  updateTask(id: string, patch: Partial<AutomationTask>): AutomationTask[];
  deleteTask(id: string): AutomationTask[];
  runTaskNow(id: string): void;

  /** Training/goal runs: the data-scientist agent + experiment-tree engine. */
  listTrainingRuns(): TrainingRun[];
  createTrainingRun(input: NewTrainingRun): TrainingRun;
  updateTrainingRun(id: string, patch: Partial<TrainingRun>): TrainingRun[];
  deleteTrainingRun(id: string): TrainingRun[];
  startTrainingRun(id: string): TrainingRun[];
  pauseTrainingRun(id: string): TrainingRun[];
  stopTrainingRun(id: string): TrainingRun[];
  addTrainingHint(id: string, text: string): TrainingRun[];

  listWorkflows(): WorkflowsSnapshot;
  createWorkflow(input: NewWorkflow): Workflow;
  updateWorkflow(id: string, patch: Partial<Workflow>): Workflow | undefined;
  deleteWorkflow(id: string): WorkflowsSnapshot;
  duplicateWorkflow(id: string): Workflow | undefined;
  runWorkflow(id: string): Promise<WorkflowRun | undefined>;
  cancelWorkflowRun(runId: string): void;
  listWorkflowRuns(workflowId?: string): WorkflowRun[];
  dispatchWorkflowEvent(event: WorkflowEvent): Promise<WorkflowRun[]>;
  dispatchWebhook(slug: string, secret: string, payload: Record<string, unknown>): Promise<WorkflowRun[]>;

  listConnectors(): ConnectorConfig[];
  connectConnector(kind: ConnectorKind, token: string, settings?: Record<string, string>): ConnectorConfig[];
  disconnectConnector(kind: ConnectorKind): ConnectorConfig[];
  fetchConnector(kind: ConnectorKind, query?: string): Promise<ConnectorResource[]>;

  /** Which agent CLIs are present and whether Nekko is installed as a subagent. */
  detectAgentTools(): AgentToolStatus[];
  /**
   * Merge the nekko-agent MCP entry into a tool's config (backs up first).
   *
   * `target` points the entry at a running local server (URL, token, and the
   * CLI the app installed). The desktop transport fills it in; without it the
   * entry is the portable `npx` form, which starts its own agent.
   */
  installSubagent(tool: AgentToolId, target?: SubagentTarget): SubagentInstallResult;
  /** The manual copy-paste config for a tool, pointed at the same target. */
  subagentSnippet(tool: AgentToolId, target?: SubagentTarget): SubagentSnippet;
  /**
   * Re-point an entry this app wrote at `target`; hand-written entries are left
   * alone. Transport-local callers only (not an IPC channel). See integrations.ts.
   */
  refreshSubagent(tool: AgentToolId, target?: SubagentTarget): boolean;

  classifyCommand(command: string): GuardrailDecision;
  usageSummary(): UsageSummary;
  getLimits(tokenKey: string, refresh?: boolean): Promise<SubscriptionLimits | undefined>;
  getLimitsProblem(tokenKey: string): Promise<import('@nekko-agent/shared').LimitsProblem | undefined>;

  /** Expose this machine over a relay so paired devices can reach it. */
  enableRemote(relayUrl: string): RemoteStatus;
  disableRemote(): RemoteStatus;
  remoteStatus(): RemoteStatus;
  remotePairing(): import('@nekko-agent/shared').RemotePairing | null;
  startRemotePairing(): import('@nekko-agent/shared').PairingGrant;
  listRemoteDevices(): import('@nekko-agent/shared').RemoteDevice[];
  revokeRemoteDevice(deviceId: string): import('@nekko-agent/shared').RemoteDevice[];
  renameRemoteDevice(deviceId: string, name: string): import('@nekko-agent/shared').RemoteDevice[];
  rotateRemoteSecret(): RemoteStatus;
  /** The remote-access service itself (headless relay-agent mode attaches here). */
  remote: import('./remote.js').RemoteService;

  /** Inbound messaging channels (Telegram bot, …): live per-channel state. */
  messagingStatus(): import('@nekko-agent/shared').MessagingStatus;

  beginOAuth(provider: OAuthProvider): Promise<OAuthSessionInfo>;
  finishOAuth(sessionId: string, pasted: string): Promise<OAuthStatus>;
  cancelOAuth(sessionId: string): Promise<void>;
  oauthStatus(providerConfigId: string): Promise<OAuthStatus>;
  oauthSignOut(providerConfigId: string): Promise<void>;
  importCliAuth(): Promise<Record<OAuthProvider, boolean>>;

  appInfo(): AppInfo;
  /** Settings → "Check now": run the model-list and skills refreshes at once. */
  runUpdateChecks(): Promise<void>;
  /** Connect (or reconnect) configured MCP servers and return their status. */
  mcpStatus(): Promise<McpServerStatus[]>;
  /** Probe for a local Hypergate daemon and return its gateway info (no side effects). */
  detectHypergate(port?: number): Promise<import('@nekko-agent/shared').HypergateInfo | null>;
  /**
   * Connect this install to a local Hypergate daemon in one step: probe it,
   * claim this install's scoped agent token, save the MCP entry, and bring its
   * tools online. Null when no daemon is listening on that port.
   */
  connectHypergate(port?: number): Promise<import('@nekko-agent/shared').HypergateInfo | null>;
}

/** The chat whose isolated checkout lives at `worktreeRoot` (see chat-worktrees.ts), or null for a deleted chat's folder. */
function chatOwner(worktreeRoot: string): { id: string; title: string; running: boolean } | null {
  const same = (a: string, b: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
  const session = sessions.listSessions().find((s) => Object.values(s.gitWorktrees ?? {}).some((w) => same(w.root, worktreeRoot)));
  return session ? { id: session.id, title: session.title, running: isChatRunning(session.id) } : null;
}

export function createHost(opts: { dataDir: string; allowBrowserControl?: boolean }): Host {
  setDataDir(opts.dataDir);
  const voice = createVoiceService(join(opts.dataDir, 'voice'), getSettings);
  const events = new EventEmitter();
  const activeChats = new Map<string, Promise<void>>();
  const interrupting = new Set<string>();
  initOAuth(events);
  initLimits(events);
  const onIndexProgress = (s: IndexStatus) => events.emit('indexProgress', s);
  // Fan terminal output out to renderers over the same event bus.
  setTerminalSender((e) => events.emit('terminalEvent', e));
  // Notify renderers when a session's tracked file changes shift.
  setChangeNotifier((sessionId) => events.emit('changesUpdated', { sessionId }));
  // Automation tasks: fired-task agent events ride the same bus as live chats;
  // task-list changes get their own event. Start the periodic scheduler.
  setTaskSender((e) => events.emit('agentEvent', e));
  // What the daemon says after a turn it drove has ended (its generated title).
  setTurnNotifier((e) => events.emit('agentEvent', e));
  setCompactionSender((e) => events.emit('agentEvent', e));
  setDecisionRunner({
    available: async () => {
      const s = await engine.decisions.status();
      return s.local.loaded ? 'local' : s.typesafe.configured ? 'typesafe' : null;
    },
    run: (provider, request) => engine.decisions.run(provider, request),
  });
  setTasksNotifier((tasks) => events.emit('tasksUpdated', tasks));
  startTaskScheduler();
  configureAgentWatches({
    busy: isChatRunning,
    exists: (id) => { const s = sessions.getSession(id); return !!s && !s.archivedAt; },
    snapshot: async (url) => {
      const pr = await fetchPrInfo(url);
      if (!pr) throw new Error('PR catalog unavailable: check GitHub authentication, repository access, or network');
      return JSON.stringify({ state: pr.state, checks: pr.checks, reviewDecision: pr.reviewDecision, isDraft: pr.isDraft, updatedAt: pr.updatedAt });
    },
    resume: async (sessionId, text) => {
      const s = sessions.getSession(sessionId);
      if (!s || s.archivedAt || s.incognito || s.offline) throw new Error('Chat cannot be resumed by a watch');
      if (!s.providerId || !s.modelId) throw new Error('Chat has no selected provider/model; no fallback was used');
      let failure: string | undefined;
      await sendChat({ sessionId, providerId: s.providerId, modelId: s.modelId, text }, (e) => {
        if (e.type === 'error') failure = e.message;
        events.emit('agentEvent', e);
      }, !!opts.allowBrowserControl);
      if (failure) throw new Error(failure);
    },
  });
  // Training/goal runs: agent events ride the shared bus; run changes get their
  // own event. Resume any runs that were mid-flight when the host went down.
  setTrainingSender((e) => events.emit('agentEvent', e));
  setTrainingNotifier((runs) => events.emit('trainingUpdated', runs));
  startTrainingScheduler();
  // Workflows: a run's agent steps stream on the shared bus, definition and run
  // changes get their own event. Any run the last shutdown interrupted is
  // written off before the scheduler starts, so it can't look stuck forever.
  setWorkflowSender((e) => events.emit('agentEvent', e));
  setWorkflowsNotifier((snapshot) => events.emit('workflowsUpdated', snapshot));
  reconcileWorkflowRuns();
  {
    // A daemon-driven turn survives this host restarting: ask which chats it
    // still drives before writing the rest off.
    const daemon = daemonCall();
    const since = Date.now();
    if (daemon) {
      void daemon<string[]>('turn:running')
        .catch(() => [] as string[])
        .then((ids) => reconcileInterruptedChats(new Set(Array.isArray(ids) ? ids : []), since));
    } else {
      reconcileInterruptedChats();
    }
  }
  startWorkflowScheduler();
  startWorkflowListeners();

  const findProvider = (id: string) => getSettings().providers.find((p) => p.id === id);

  /**
   * Keep one provider entry pointing at the engine.
   *
   * It exists from the first launch rather than from the first successful start,
   * because the Models tab addresses the engine through it: no entry means no id
   * to send a start to, and a start that cannot be addressed is a dead button.
   */
  function ensureEngineProvider(baseUrl: string): void {
    const providers = getSettings().providers;
    const existing = providers.find((p) => p.kind === 'llamacpp');
    if (existing?.baseUrl === baseUrl) return;
    const entry: ProviderConfig = {
      id: existing?.id ?? 'nekko-engine',
      kind: 'llamacpp',
      label: existing?.label ?? 'Nekko Agent engine',
      baseUrl,
      enabled: true,
    };
    saveSettings({ providers: [...providers.filter((p) => p.id !== entry.id), entry] });
  }

  // The engine we run ourselves: llama.cpp behind a router of our own, plus the
  // catalog and library that feed it. Its settings live in the same settings
  // file as everything else, so a missing block reads as the defaults.
  const engine = createEngine({
    dataDir,
    getGpuStats,
    getGpuStatsFresh,
    getGpuAdapters: detectGpuAdapters,
    settings: () => ({ ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine }),
    promptCaching: () => getSettings().promptCaching !== false,
    saveSettings: async (patch) => {
      const next = { ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine, ...patch };
      saveSettings({ engine: next });
      return next;
    },
    onDownloadsChanged: (jobs) => events.emit('downloadsUpdated', jobs),
    // A running engine nobody can select is a running engine for nothing, so its
    // provider entry is kept in step with the address it is actually serving on.
    onServing: (baseUrl) => ensureEngineProvider(baseUrl),
    hfToken: () => getSettings().hfToken || undefined,
    typesafeKey: () => getSettings().typesafeApiKey || process.env.TYPESAFE_API_KEY || undefined,
    decisionFolders: () => getSettings().decisionModelDirs ?? [],
    saveDecisionFolders: (dirs) => { saveSettings({ decisionModelDirs: dirs }); },
    externalBinPath: () => getSettings().engineBinPath || undefined,
  });

  registerManagedCacheEndpoint(() => engine.isRunning() ? engineBaseUrl({ ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine }) : undefined);
  ensureEngineProvider(engineBaseUrl({ ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine }));
  // A machine that already runs models through Ollama or LM Studio should show
  // them without anyone finding the folder screen first. Once only, and never
  // fatal: a folder we cannot read is a folder we skip, not a failed startup.
  void engine.seedFolders().catch(() => {});
  // Opt-in only, and never fatal: a port taken by something else should leave a
  // line in the engine's log for the Models tab to show, not stop the app from
  // starting.
  if (getSettings().engine?.autoStart) {
    void engine.start().catch(() => {});
  }

  // The runtime control plane. Providers come from settings, hardware from the
  // existing GPU and system probes, so it stays a thin join over what exists.
  const runtimes = createRuntimes({
    findProvider,
    getGpuStats,
    getSystemStats,
    engine,
  });

  // Periodic catalog refreshes (Settings → Updates): provider model lists and
  // the skills shelf, each on its own toggle. The `host.listModels` call inside
  // the service is deferred past construction.
  const updateChecks = startUpdateChecks({
    settings: getSettings,
    listModels: (id) => host.listModels(id),
    emit: (channel, payload) => events.emit(channel, payload),
  });

  const host: Host = {
    events,
    dataDir,
    remote: null as unknown as import('./remote.js').RemoteService, // set right after construction (needs `host`)

    getSettings,
    updateSettings: (patch) => {
      const next = saveSettings(patch);
      if (patch.voice !== undefined) voice.stop();
      if (patch.messaging !== undefined) messaging.update(next.messaging);
      return next;
    },

    listProviders: () => getSettings().providers,
    saveProvider: (p) => {
      const providers = getSettings().providers.filter((x) => x.id !== p.id);
      providers.push(p);
      return saveSettings({ providers }).providers;
    },
    removeProvider: (id) => {
      const removed = findProvider(id);
      if (removed?.tokenKey) clearLimits(removed.tokenKey);
      const providers = getSettings().providers.filter((x) => x.id !== id);
      return saveSettings({ providers }).providers;
    },
    discoverProviders: async () => {
      const discovered = await discoverLocalProviders();
      const merged = [...getSettings().providers];
      for (const d of discovered) if (!merged.some((p) => p.baseUrl === d.baseUrl)) merged.push(d);
      return saveSettings({ providers: merged }).providers;
    },
    probeProviders: () => discoverLocalProviders(),
    testProvider: async (id) => {
      const p = findProvider(id);
      if (!p) return { ok: false, message: 'Not found' };
      try {
        const resolved = await resolveSubscriptionProvider(p);
        return await createProvider(resolved).test();
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    testProviderConfig: async (cfg) => {
      try {
        const resolved = await resolveSubscriptionProvider(cfg);
        return await createProvider(resolved).test();
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    listModels: async (providerId) => {
      const p = findProvider(providerId);
      if (!p) return [];
      try {
        const resolved = await resolveSubscriptionProvider(p);
        return await createProvider(resolved).listModels();
      } catch {
        return [];
      }
    },
    pullModel: async (providerId, model) => {
      const p = findProvider(providerId);
      if (!p || p.kind !== 'ollama') return { ok: false, message: 'Pull supported on Ollama only.' };
      try {
        await new OllamaProvider(p).pull(model);
        return { ok: true, message: `Pulled ${model}` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    loadModel: async (providerId, model) => {
      const p = findProvider(providerId);
      if (p?.kind === 'ollama') return new OllamaProvider(p).setLoaded(model, true);
      // LM Studio has no HTTP load; drive its `lms` CLI for a local instance.
      if (p?.kind === 'lmstudio') return lmsLoad(p.baseUrl, model);
      // Anything else that is a managed runtime loads through the control plane,
      // which is what owns the process the model ends up in.
      if (p && isRuntimeKind(p.kind)) return runtimes.load(providerId, model, {});
      return { ok: true };
    },
    unloadModel: async (providerId, model) => {
      const p = findProvider(providerId);
      if (p?.kind === 'ollama') return new OllamaProvider(p).setLoaded(model, false);
      // LM Studio has no HTTP per-model unload; drive its `lms` CLI instead.
      if (p?.kind === 'lmstudio') return lmsUnload(p.baseUrl, model);
      if (p && isRuntimeKind(p.kind)) return runtimes.unload(providerId, model);
      return { ok: true };
    },
    lmsAvailable: async (providerId) => {
      const p = findProvider(providerId);
      if (p?.kind !== 'lmstudio') return { available: false };
      return lmsProbe(p.baseUrl);
    },
    stopServer: async (providerId) => {
      const p = findProvider(providerId);
      if (!p) return { ok: false, message: 'Provider not found.' };
      if (!isLocalProvider(p.kind)) return { ok: false, message: 'Only local model servers can be stopped from here.' };
      return stopLocalServer(p.baseUrl);
    },
    runtimeStatus: (providerId) => runtimes.status(providerId),
    runtimeStart: (providerId) => runtimes.start(providerId),
    runtimeStop: (providerId, force) => { if (providerId === 'nekko-engine') voice.stop(); return runtimes.stop(providerId, force); },
    runtimeLoad: (providerId, modelId, params) => runtimes.load(providerId, modelId, params),
    runtimeFacts: (providerId) => runtimes.facts(providerId),
    runtimePlan: (providerId, modelId, req) => runtimes.plan(providerId, modelId, req),
    runtimeAutoFit: (providerId, modelId, budgetFraction, parallelSlots) =>
      runtimes.autoPlan(providerId, modelId, budgetFraction, parallelSlots),

    voiceStatus: () => voice.status(),
    voiceInstall: () => voice.install(),
    voiceCancelInstall: () => voice.cancel(),
    voiceUninstall: () => voice.uninstall(),
    voiceTranscribe: (wav) => voice.transcribe(wav),
    engineStatus: () => engine.status(),
    engineRouterLoad: (modelId, image) => engine.routerLoad(modelId, image),
    loopTool,
    loopEvent,
    loopEnd,
    loopApprove,
    loopLog,
    turnCallback,
    changesNotify: notifyChanges,
    engineRouterModels: () => engine.routerModels(),
    engineRouterModel: (modelId) => engine.routerModel(modelId),
    engineInstall: (buildId, runtime) => engine.installEngine(buildId, runtime),
    engineUninstall: (runtime) => engine.uninstallEngine(runtime),
    engineInstallPreview: (runtime, buildId) => engine.installPreview(runtime, buildId),
    engineGenerateImage: (request) => engine.generateImage(request),
    engineSettingsSave: (patch) => engine.saveSettings(patch),
    engineModels: () => engine.models(),
    engineImportModel: (path) => engine.importModel(path),
    engineDeleteModel: (id) => engine.deleteModel(id),
    engineSaveModelPreset: (id, preset) => engine.saveModelPreset(id, preset),
    engineCatalog: (query, format) =>
      format === 'mlx' ? engine.catalogSearch(query ?? '', 20, 'mlx') : query ? engine.catalogSearch(query) : engine.catalogCurated(),
    engineCatalogModel: (id) => engine.catalogModel(id),
    engineCatalogDetail: (id) => engine.catalogDetail(id),
    engineFolders: () => engine.folders(),
    engineFoldersSave: (folders) => engine.saveFolders(folders),
    engineDownloadModel: (modelId, quantLabel) => engine.downloadModel(modelId, quantLabel),
    engineDownloadCompanions: (modelId) => engine.downloadCompanions(modelId),
    engineImageCompanions: (modelId) => engine.imageCompanions(modelId),
    engineDownloadImageCompanions: (modelId) => engine.downloadImageCompanions(modelId),
    decisionsCatalog: () => engine.decisions.catalog(),
    decisionsModels: () => engine.decisions.models(),
    decisionsDownload: (catalogId, precision) => engine.decisions.download(catalogId, precision),
    decisionsDelete: (id) => engine.decisions.remove(id),
    decisionsAddFolder: (path) => engine.decisions.addFolder(path),
    decisionsStatus: () => engine.decisions.status(),
    decisionsLoad: (id, precision) => engine.decisions.load(id, precision),
    decisionsUnload: () => engine.decisions.unload(),
    decisionsRun: (provider, request) => engine.decisions.run(provider, request),
    decisionsCheckTypesafe: () => engine.decisions.checkTypesafe(),
    engineSetResidentTtl: async (modelId, ttlSeconds) => engine.setResidentTtl(modelId, ttlSeconds),
    engineSetAutoload: (modelId, enabled) => engine.setAutoload(modelId, enabled),
    engineDownloads: async () => engine.downloads(),
    engineCancelDownload: async (id) => engine.cancelDownload(id),
    engineDismissDownload: async (id) => engine.dismissDownload(id),
    machineReadiness: async (language) =>
      evaluateReadiness(await gatherMachineFacts(), OFFLINE_STACK_CATALOG, { language }),

    getGpuStats: () => getGpuStats(),
    getSystemStats: () => getSystemStats(),

    listSessions: sessions.listSessions,
    nextAgentWatchAt: (id) => nextAgentWatchAt(id),
    listSessionSummaries: sessions.listSessionSummaries,
    configureSandbox: (id, image) => { if (isChatRunning(id) || activeChats.has(id)) throw new Error('Wait for the current reply to finish before sandbox setup.'); return configureSandbox(id, image); },
    cleanupSandbox: (id, identity) => { if (isChatRunning(id) || activeChats.has(id)) throw new Error('Wait for the current reply to finish before sandbox cleanup.'); return cleanupSandbox(id, identity); },
    sandboxStatus,
    sandboxDiff,
    applySandboxDiff,
    createSession: (workspaceId) => {
      if (workspaceId && !getSettings().workspaces.some((w) => w.id === workspaceId)) throw new Error('Workspace not found');
      return sessions.createSession(workspaceId);
    },
    getSession: sessions.getSession,
    deleteSession: sessions.deleteSession,
    setSessionWorkspace: (id, workspaceId) => {
      if (activeChats.has(id) || isChatRunning(id)) throw new Error('Wait for the current reply to finish before changing folders.');
      if (workspaceId && !getSettings().workspaces.some((w) => w.id === workspaceId)) throw new Error('Workspace not found');
      return sessions.setSessionWorkspace(id, workspaceId);
    },
    setSessionSupportingWorkspaces: (id, workspaceIds) => {
      if (activeChats.has(id) || isChatRunning(id)) throw new Error('Wait for the current reply to finish before changing folders.');
      if (workspaceIds.some((wid) => !getSettings().workspaces.some((w) => w.id === wid))) throw new Error('Workspace not found');
      return sessions.setSessionSupportingWorkspaces(id, workspaceIds);
    },
    setSessionAttachments: sessions.setSessionAttachments,
    buildSpec,
    buildSpecDoc,
    readSpecDocs,
    setSpecMethodology,
    toggleSpecTask,
    setSpecLinked: sessions.setSpecLinked,
    specPath: specPathForSession,
    setSessionOptions: (id, patch) => {
      if ((Object.prototype.hasOwnProperty.call(patch, 'gitIsolation') || Object.prototype.hasOwnProperty.call(patch, 'executionMode')) && (isChatRunning(id) || activeChats.has(id))) {
        throw new Error('Wait for the current reply to finish before changing this chat\'s Git isolation.');
      }
      return sessions.setSessionOptions(id, patch);
    },
    truncateSession: sessions.truncateSession,
    clearSessions: sessions.clearSessions,
    purgeExpiredArchives: () => sessions.purgeExpiredArchives(),
    forkSession: (id, beforeMessageId) => sessions.forkSession(id, beforeMessageId),
    resetSettings,
    wipeAllData: () => {
      sessions.clearSessions('all');
      memory.clearMemory();
      clearUsage();
      clearLimits();
      return resetSettings();
    },
    listTools: () => [...BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description })), ...mcpToolList()],
    sendChat: (o) => {
      if (interrupting.has(o.sessionId)) throw new Error('A queued prompt is already starting.');
      if (isSessionCompacting(o.sessionId)) {
        events.emit('agentEvent', { type: 'error', sessionId: o.sessionId, message: 'This chat is being compacted. Wait or move to a new chat.' });
        return Promise.resolve();
      }
      const run = sendChat(o, (e) => events.emit('agentEvent', e), !!opts.allowBrowserControl);
      activeChats.set(o.sessionId, run);
      void run.finally(() => { if (activeChats.get(o.sessionId) === run) activeChats.delete(o.sessionId); }).catch(() => {});
      return run;
    },
    abortChat: (sessionId) => {
      if (!abortImageTurn(sessionId)) abortChat(sessionId);
    },
    sessionImages: (sessionId, limit) => sessionImages(sessionId, limit),
    generateImageTurn: (o) => {
      assertHostExecution(o.sessionId, 'Image generation');
      const run = generateImageTurn(o, (request, onStage) => engine.generateImage(request, onStage), (e) => events.emit('agentEvent', e));
      activeChats.set(o.sessionId, run);
      void run.finally(() => { if (activeChats.get(o.sessionId) === run) activeChats.delete(o.sessionId); }).catch(() => {});
      return run;
    },
    compactSession,
    cancelSessionCompaction,
    queuePrompt: sessions.queuePrompt,
    dequeuePrompt: sessions.dequeuePrompt,
    steerChat,
    interruptQueuedPrompt: async (sessionId, index, brain) => {
      const session = sessions.getSession(sessionId);
      if (!session) throw new Error('Session not found.');
      if (!Number.isSafeInteger(index) || index < 0 || index >= (session.queue?.length ?? 0)) throw new Error('Queued prompt not found.');
      if (interrupting.has(sessionId)) throw new Error('A queued prompt is already starting.');
      if (isSessionCompacting(sessionId)) throw new Error('This chat is being compacted.');
      const providerId = brain?.providerId ?? session.providerId ?? getSettings().defaultProviderId;
      const modelId = brain?.modelId ?? session.modelId ?? getSettings().defaultModelId;
      if (!providerId || !modelId || modelId === AUTO_MODEL_ID) throw new Error('Choose a provider and model before starting the queued prompt.');
      const item = session.queue![index];
      const payload = queueItemPayload(item);
      const text = payload.text;
      interrupting.add(sessionId);
      try {
        const active = activeChats.get(sessionId);
        if (active) {
          abortChat(sessionId);
          await active.catch(() => {});
        } else if (abortImageTurn(sessionId)) {
          throw new Error('Image turn is still stopping. Try again when it finishes.');
        }
        if (isSessionCompacting(sessionId)) throw new Error('This chat is being compacted.');
        await sendChat({ sessionId, providerId, modelId, text, ...(payload.images?.length ? { images: payload.images } : {}), ...(payload.skill ? { skill: payload.skill } : {}) }, (e) => events.emit('agentEvent', e), !!opts.allowBrowserControl, { index, item });
      } finally {
        interrupting.delete(sessionId);
      }
    },
    suggestReplies,
    resourceQueue,
    fillPromptPart,
    approveTool: (sessionId, toolCallId, approved) => resolveApproval(sessionId, toolCallId, approved),
    answerQuestion: (sessionId, callId, answers) => answerQuestion(sessionId, callId, answers),
    pendingInput: getPendingInput,
    hostPendingInput: getHostPendingInput,
    runningSessions: getRunningSessionIds,

    listTerminals,
    listShells,
    createTerminal,
    terminalSnapshot,
    updateTerminal,
    writeTerminal,
    resizeTerminal,
    runInTerminal,
    signalTerminal,
    closeTerminal,

    previewContext,
    setContextPrefs,

    listMemory: memory.listMemory,
    saveMemory: (entry) => {
      memory.saveMemory(entry);
      return memory.listMemory(entry.scope, entry.workspaceId);
    },
    deleteMemory: memory.deleteMemory,

    listWorkspaces: () => getSettings().workspaces,
    addWorkspaceByPath: (path) => {
      // A path already registered is reused, never added (or indexed) twice.
      const current = getSettings().workspaces;
      if (current.some((w) => sameFolderPath(w.path, path))) return current;

      // Two folders added in the same millisecond must not share an id.
      const stamp = `ws_${Date.now().toString(36)}`;
      let id = stamp;
      for (let n = 1; current.some((w) => w.id === id); n++) id = `${stamp}_${n}`;
      const folder: WorkspaceFolder = {
        id,
        name: basename(path),
        path,
        addedAt: Date.now(),
      };
      const workspaces = [...current, folder];
      saveSettings({ workspaces });
      setTimeout(() => indexWorkspace(folder, onIndexProgress), 50);
      return workspaces;
    },
    removeWorkspace: (id) => {
      const affected = sessions.listSessions().filter((s) => s.workspaceId === id || s.supportingWorkspaceIds?.includes(id));
      if (affected.some((s) => activeChats.has(s.id) || isChatRunning(s.id))) {
        throw new Error('Wait for chats using this folder to finish before revoking access.');
      }
      // Revoke saved access only. Never remove the folder or its files.
      for (const s of affected) {
        if (s.workspaceId === id) s.workspaceId = undefined;
        s.supportingWorkspaceIds = s.supportingWorkspaceIds?.filter((wid) => wid !== id);
        sessions.saveSession(s);
      }
      const workspaces = getSettings().workspaces.filter((w) => w.id !== id);
      return saveSettings({ workspaces }).workspaces;
    },
    indexWorkspace: (id) => {
      const folder = getSettings().workspaces.find((w) => w.id === id);
      if (!folder) throw new Error('Workspace not found');
      return indexWorkspace(folder, onIndexProgress);
    },
    getIndexStatus,
    searchWorkspace: (id, query) => {
      const folder = getSettings().workspaces.find((w) => w.id === id);
      return folder ? searchWorkspace(folder, query) : [];
    },
    listFiles: listIndexedFiles,
    getGitStatus,
    listChatWorktrees: () => listChatWorktrees(getSettings(), chatOwner),
    removeChatWorktree: (root) => removeChatWorktree(getSettings(), root, chatOwner),
    readFile,
    writeFile,
    listDir,
    listChanges,
    acceptChange,
    acceptAllChanges,
    listSessionPrs,
    getPrDiff,
    prAction,
    listComments,
    addComment,
    resolveComment,
    getDesignBoard,
    addDesignPage,
    updateDesignPage,
    removeDesignPage,
    addDesignNote,
    resolveDesignNote,
    generateDesign,
    listInstalledSkills,
    listExternalSkills: () =>
      discoverExternalSkills({
        projectRoots: getSettings().workspaces.map((w) => w.path),
        exclude: listInstalledSkills().flatMap((r) => (r.path ? [r.path] : [])),
        reserved: [...SKILLS, ...listInstalledSkillDefs()].map((s) => s.name),
      }),
    skillTargets,
    installSkill,
    uninstallSkill,
    vaizerCatalog: (refresh?: boolean) => getVaizerCatalog(refresh),
    vaizerSkillMd: (slug: string) => getVaizerSkillMd(slug),

    listTasks,
    createTask,
    updateTask,
    deleteTask,
    runTaskNow,

    listTrainingRuns,
    createTrainingRun,
    updateTrainingRun,
    deleteTrainingRun,
    startTrainingRun,
    pauseTrainingRun,
    stopTrainingRun,
    addTrainingHint,

    listWorkflows: workflowsSnapshot,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow: (id: string) => {
      deleteWorkflow(id);
      return workflowsSnapshot();
    },
    duplicateWorkflow,
    runWorkflow: (id: string) => runWorkflow(id),
    cancelWorkflowRun,
    listWorkflowRuns,
    dispatchWorkflowEvent,
    dispatchWebhook,

    listConnectors: () => getSettings().connectors,
    connectConnector: (kind, token, settings) => {
      const connectors = getSettings().connectors.filter((c) => c.kind !== kind);
      connectors.push({ kind, connected: true, token, settings, connectedAt: Date.now() });
      return saveSettings({ connectors }).connectors;
    },
    disconnectConnector: (kind) => {
      const connectors = getSettings().connectors.filter((c) => c.kind !== kind);
      return saveSettings({ connectors }).connectors;
    },
    fetchConnector: async (kind, query) => {
      const cfg = getSettings().connectors.find((c) => c.kind === kind);
      // Some connectors work without a token (e.g. a Teams incoming webhook
      // lives in settings), so connected-not-token is the gate; a connector
      // that genuinely needs a token fails on its own fetch.
      if (!cfg?.connected) throw new Error('Connector not connected');
      return getConnector(kind).fetch(cfg.token ?? '', query, cfg.settings);
    },

    detectAgentTools: () => detectAgentTools(),
    installSubagent: (tool, target) => installSubagent(tool, undefined, target),
    subagentSnippet: (tool, target) => subagentSnippet(tool, target),
    refreshSubagent: (tool, target) => refreshSubagent(tool, undefined, target),

    classifyCommand: (command) => classifyCommand(command, getSettings().guardrails),
    usageSummary,
    getLimits: (tokenKey, refresh) => getLimits(tokenKey, refresh),
    getLimitsProblem: async (tokenKey) => getLimitsProblem(tokenKey),

    enableRemote: (relayUrl) => host.remote.enable(relayUrl),
    disableRemote: () => host.remote.disable(),
    remoteStatus: () => host.remote.status(),
    remotePairing: () => host.remote.pairing(),
    startRemotePairing: () => host.remote.pair(),
    listRemoteDevices: () => host.remote.devices(),
    revokeRemoteDevice: (deviceId) => host.remote.revoke(deviceId),
    renameRemoteDevice: (deviceId, name) => host.remote.rename(deviceId, name),
    rotateRemoteSecret: () => host.remote.rotate(),

    messagingStatus: () => messaging.status(),

    beginOAuth,
    finishOAuth,
    cancelOAuth: async (sessionId) => { cancelOAuth(sessionId); },
    oauthStatus: async (providerConfigId) => {
      const provider = findProvider(providerConfigId);
      if (!provider?.tokenKey) {
        return {
          tokenKey: providerConfigId,
          connected: false,
          state: 'missing',
          message: provider ? 'Provider has no token key.' : 'Provider not found.',
        };
      }
      return getOAuthStatus(provider.tokenKey);
    },
    oauthSignOut: async (providerConfigId) => {
      const provider = findProvider(providerConfigId);
      if (provider?.tokenKey) {
        signOutOAuth(provider.tokenKey);
        clearLimits(provider.tokenKey);
      }
    },
    importCliAuth: async () => importCliAuth(),

    appInfo: () => ({ version: brandEnv('VERSION') ?? '0.0.0', platform: process.platform, edition: 'web' }),
    runUpdateChecks: () => updateChecks.runNow(),
    mcpStatus: async () => {
      const configs = getSettings().mcpServers ?? [];
      await syncMcp(configs);
      return mcpStatus(configs);
    },
    detectHypergate: (port) => detectHypergate(port),
    connectHypergate: async (port) => {
      const info = await resolveHypergate(port);
      if (!info) return null;
      // Save first, then sync: `syncMcp` reads the list it is given, and a
      // connect that brought tools online without persisting the entry would
      // come back disconnected on the next launch.
      const next = saveSettings({ mcpServers: withHypergate(getSettings().mcpServers ?? [], info) });
      await syncMcp(next.mcpServers ?? []);
      return info;
    },
  };
  // Remote access needs the finished host (it dispatches into it); reconnect if
  // remote access was left enabled when the host last shut down.
  host.remote = createRemoteService(host);
  host.remote.startIfEnabled();
  // Messaging channels likewise drive the host; configured adapters come up
  // with the process and reconfigure through updateSettings above.
  const messaging = createMessagingService(host);
  messaging.update(getSettings().messaging);
  return host;
}
