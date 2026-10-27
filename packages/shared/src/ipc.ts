/** IPC channel contracts between renderer and main. */

import type { AppSettings, UsageSummary } from './settings.js';
import type { ProviderConfig, ModelInfo } from './models.js';
import type { Session, SendOptions, AgentEvent, PendingInput, ReplySuggestions } from './chat.js';
import type { TerminalInfo, TerminalSnapshot, ShellOption, SshHost } from './terminal.js';
import type { ContextBundle } from './context.js';
import type { MemoryEntry, MemoryScope } from './memory.js';
import type { WorkspaceFolder, IndexStatus, SearchHit, IndexedFile } from './workspace.js';
import type {
  DirEntry,
  FileContent,
  FileChange,
  LineComment,
  RemoteImage,
  ScopedFile,
  ScopedListing,
  ScopedRoot,
  ScopedSearch,
  ScopedWriteResult,
} from './files.js';
import type { LogInfo, LogRead, LogReadOptions } from './logs.js';
import type { DesignBoard, DesignPage, GenerateDesignInput } from './design.js';
import type { AutomationTask, NewTask } from './tasks.js';
import type { TrainingRun, NewTrainingRun } from './training.js';
import type { NewWorkflow, Workflow, WorkflowEvent, WorkflowRun, WorkflowsSnapshot } from './workflows.js';
import type { ConnectRequest, RunnerSettings, RunnerView } from './runners.js';
import type { ConnectorConfig, ConnectorKind, ConnectorResource } from './connectors.js';
import type {
  AgentToolId,
  AgentToolStatus,
  SubagentInstallResult,
  SubagentSnippet,
  SubagentTarget,
} from './integrations.js';
import type { GuardrailRule } from './guardrails.js';
import type { OAuthProvider, OAuthSessionInfo, OAuthStatus } from './oauth.js';
import type { SubscriptionLimits } from './limits.js';
import type { AppInfo, UpdateInfo } from './update.js';

/** Invoke (request/response) channels. */
export const IpcChannels = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersRemove: 'providers:remove',
  providersDiscover: 'providers:discover',
  providersProbe: 'providers:probe',
  providersTest: 'providers:test',
  providersTestConfig: 'providers:testConfig',
  /** Provider setup from a phone (decision 0016): the computer's sealing key, a sealed save, one provider's switch. */
  providersSealKey: 'providers:sealKey',
  providersSaveSealed: 'providers:saveSealed',
  providersSetEnabled: 'providers:setEnabled',

  modelsList: 'models:list',
  modelsListStatus: 'models:listStatus',
  modelPull: 'model:pull',
  modelLoad: 'model:load',
  modelUnload: 'model:unload',
  lmsProbe: 'lms:probe',
  serverStop: 'server:stop',
  runtimeStatus: 'runtime:status',
  runtimeStart: 'runtime:start',
  runtimeStop: 'runtime:stop',
  runtimeLoad: 'runtime:load',
  runtimeFacts: 'runtime:facts',
  runtimePlan: 'runtime:plan',
  runtimeAutoFit: 'runtime:autoFit',
  runtimePlace: 'runtime:place',
  runtimeRecommend: 'runtime:recommend',

  engineStatus: 'engine:status',
  engineInstallPreview: 'engine:installPreview',
  engineGenerateImage: 'engine:generateImage',
  engineInstall: 'engine:install',
  engineUninstall: 'engine:uninstall',
  engineSettingsSave: 'engine:settings',
  engineModels: 'engine:models',
  engineImportModel: 'engine:importModel',
  engineDeleteModel: 'engine:deleteModel',
  engineSaveModelPreset: 'engine:saveModelPreset',
  engineCatalog: 'engine:catalog',
  engineCatalogModel: 'engine:catalogModel',
  engineCatalogDetail: 'engine:catalogDetail',
  engineDownloadModel: 'engine:downloadModel',
  engineDownloadCompanions: 'engine:downloadCompanions',
  engineImageCompanions: 'engine:imageCompanions',
  engineDownloadImageCompanions: 'engine:downloadImageCompanions',
  decisionsCatalog: 'decisions:catalog',
  decisionsModels: 'decisions:models',
  decisionsDownload: 'decisions:download',
  decisionsDelete: 'decisions:delete',
  decisionsAddFolder: 'decisions:addFolder',
  decisionsStatus: 'decisions:status',
  decisionsLoad: 'decisions:load',
  decisionsUnload: 'decisions:unload',
  decisionsRun: 'decisions:run',
  decisionsCheckTypesafe: 'decisions:checkTypesafe',
  engineSetResidentTtl: 'engine:residentTtl',
  engineSetAutoload: 'engine:autoload',
  engineFolders: 'engine:folders',
  engineFoldersSave: 'engine:foldersSave',
  apiServerStatus: 'apiServer:status',
  apiServerSave: 'apiServer:save',
  apiServerNewToken: 'apiServer:newToken',
  cliInstallStatus: 'cli:installStatus',
  cliInstall: 'cli:install',

  engineDownloads: 'engine:downloads',
  engineCancelDownload: 'engine:cancelDownload',
  engineDismissDownload: 'engine:dismissDownload',

  machineReadiness: 'machine:readiness',
  machineProfile: 'machine:profile',
  /** One phone-safe read for a computer's page: version, hardware, live stats, the model server (2026-10-24). */
  machineSummary: 'machine:summary',
  machineRecommendations: 'machine:recommendations',
  /** Background automations on a local model, and how many are paused for the user. */
  backgroundState: 'background:state',
  machineDismissNudge: 'machine:dismissNudge',
  gpuStats: 'gpu:stats',
  systemStats: 'system:stats',
  /** The phone's Monitors pane (FD-1): answered by the phone gate from the other monitor, chat and automation reads. */
  monitorSummary: 'monitor:summary',

  sessionsList: 'sessions:list',
  sessionNextWatch: 'session:nextWatch',
  sessionWatches: 'session:watches',
  sessionCancelWatch: 'session:cancelWatch',
  sessionsSummaries: 'sessions:summaries',
  sessionCreate: 'session:create',
  sessionGet: 'session:get',
  sessionDelete: 'session:delete',
  sessionSetWorkspace: 'session:setWorkspace',
  sessionSetSupportingWorkspaces: 'session:setSupportingWorkspaces',
  chatSend: 'chat:send',
  chatGenerateImage: 'chat:generateImage',
  sessionImages: 'session:images',
  chatAbort: 'chat:abort',
  chatCompact: 'chat:compact',
  chatCancelCompaction: 'chat:cancelCompaction',
  chatQueue: 'chat:queue',
  chatDequeue: 'chat:dequeue',
  /** Change or remove a queued prompt, checked against the text the editor showed (a phone's queue). */
  chatEditQueued: 'chat:editQueued',
  chatInterruptQueued: 'chat:interruptQueued',
  chatSteer: 'chat:steer',
  chatSuggest: 'chat:suggest',
  resourceQueue: 'resource:queue',
  chatFillPrompt: 'chat:fillPrompt',
  toolApprove: 'tool:approve',
  chatAnswer: 'chat:answer',
  chatPending: 'chat:pending',
  chatRunning: 'chat:running',

  terminalsList: 'terminals:list',
  terminalShells: 'terminal:shells',
  terminalCreate: 'terminal:create',
  terminalSnapshot: 'terminal:snapshot',
  terminalUpdate: 'terminal:update',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalRun: 'terminal:run',
  terminalSignal: 'terminal:signal',
  terminalClose: 'terminal:close',
  /** The last N bytes of scroll-back (64 KB by default, 512 KB at most), cut cleanly. */
  terminalTail: 'terminal:tail',
  /** Host aliases from the computer's ~/.ssh/config, for display. */
  sshHosts: 'ssh:hosts',
  /** A terminal running the system `ssh` to one of those aliases. */
  sshOpen: 'ssh:open',

  contextPreview: 'context:preview',
  contextToggle: 'context:toggle',
  contextSetPrefs: 'context:setPrefs',
  sessionSetAttachments: 'session:setAttachments',
  specBuild: 'spec:build',
  specBuildDoc: 'spec:buildDoc',
  specReadDocs: 'spec:readDocs',
  specSetMethodology: 'spec:setMethodology',
  specToggleTask: 'spec:toggleTask',
  specSetLinked: 'spec:setLinked',
  specPath: 'spec:path',
  sessionSetOptions: 'session:setOptions',
  sessionTruncate: 'session:truncate',
  sessionsClear: 'sessions:clear',
  sessionsPurgeArchived: 'sessions:purgeArchived',
  sessionsHistoryUsage: 'sessions:historyUsage',
  sessionsClearHistory: 'sessions:clearHistory',
  sessionFork: 'session:fork',
  settingsReset: 'settings:reset',
  fontsList: 'fonts:list',
  dataWipe: 'data:wipe',
  toolsList: 'tools:list',

  // Transport-local (handled by Electron main / web-client, not the host dispatcher)
  dialogOpenFiles: 'dialog:openFiles',
  openPath: 'shell:openPath',

  memoryList: 'memory:list',
  memorySave: 'memory:save',
  memoryDelete: 'memory:delete',

  workspaceList: 'workspace:list',
  workspaceAdd: 'workspace:add',
  workspaceAddByPath: 'workspace:addByPath',
  workspaceRemove: 'workspace:remove',
  workspaceIndex: 'workspace:index',
  workspaceIndexStatus: 'workspace:indexStatus',
  workspaceSearch: 'workspace:search',
  workspaceFiles: 'workspace:files',
  workspaceGitStatus: 'workspace:gitStatus',
  sandboxConfigure: 'sandbox:configure',
  sandboxStatus: 'sandbox:status',
  sandboxCleanup: 'sandbox:cleanup',
  sandboxDiff: 'sandbox:diff',
  sandboxApplyDiff: 'sandbox:applyDiff',
  chatWorktreesList: 'chatWorktrees:list',
  chatWorktreesRemove: 'chatWorktrees:remove',

  fileRead: 'file:read',
  fileWrite: 'file:write',
  dirList: 'dir:list',
  /** Files in a chat's or saved folder, relative to it, secrets hidden (IO-33 FA-1). */
  filesList: 'files:list',
  filesSearch: 'files:search',
  filesRead: 'files:read',
  filesWrite: 'files:write',
  /** The app's, the engine's and each chat's agent logs, redacted (IO-33 FA-5). */
  logsList: 'logs:list',
  logsRead: 'logs:read',
  /** What the agent linked in a chat, for a phone (#1095): a linked file or a page's asset, and a linked local preview server. */
  artifactRead: 'artifact:read',
  previewFetch: 'preview:fetch',
  /** What Privacy Shield would hide from a cloud model in a chat and its draft. */
  privacyPreview: 'privacy:preview',
  attachmentImport: 'attachment:import',
  imageFetch: 'image:fetch',

  changesList: 'changes:list',
  changeAccept: 'changes:accept',
  changeAcceptAll: 'changes:acceptAll',

  prSessionList: 'pr:sessionList',
  prDiff: 'pr:diff',
  prAction: 'pr:action',
  prContinueStack: 'pr:continueStack',
  prLinkStack: 'pr:linkStack',
  prCreate: 'pr:create',
  prChecks: 'pr:checks',

  gitDiff: 'git:diff',
  gitLog: 'git:log',
  gitShow: 'git:show',
  gitBranches: 'git:branches',
  gitCompare: 'git:compare',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitCommit: 'git:commit',
  gitCommitMessage: 'git:commitMessage',
  gitPush: 'git:push',
  gitSwitch: 'git:switch',
  gitMergeAbort: 'git:mergeAbort',

  commentsList: 'comments:list',
  commentAdd: 'comment:add',
  commentResolve: 'comment:resolve',

  designGet: 'design:get',
  designAddPage: 'design:addPage',
  designUpdatePage: 'design:updatePage',
  designRemovePage: 'design:removePage',
  designAddNote: 'design:addNote',
  designResolveNote: 'design:resolveNote',
  designGenerate: 'design:generate',

  skillsInstalled: 'skills:installed',
  skillsExternal: 'skills:external',
  skillsTargets: 'skills:targets',
  /** Every skill a chat can run by name, with templates (a phone receives them without). */
  skillsRunnable: 'skills:runnable',
  skillInstall: 'skill:install',
  skillUninstall: 'skill:uninstall',

  vaizerCatalog: 'vaizer:catalog',
  vaizerSkillMd: 'vaizer:skillMd',

  skillSourcesList: 'skillSources:list',
  skillSourcesPreview: 'skillSources:preview',
  skillSourcesFetch: 'skillSources:fetch',
  skillSourcesSearch: 'skillSources:search',

  tasksList: 'tasks:list',
  taskCreate: 'task:create',
  taskUpdate: 'task:update',
  taskDelete: 'task:delete',
  taskRunNow: 'task:runNow',

  trainingList: 'training:list',
  trainingCreate: 'training:create',
  trainingUpdate: 'training:update',
  trainingDelete: 'training:delete',
  trainingStart: 'training:start',
  trainingPause: 'training:pause',
  trainingStop: 'training:stop',
  trainingHint: 'training:hint',

  workflowsList: 'workflows:list',
  workflowCreate: 'workflow:create',
  workflowUpdate: 'workflow:update',
  workflowDelete: 'workflow:delete',
  workflowDuplicate: 'workflow:duplicate',
  workflowRun: 'workflow:run',
  workflowCancel: 'workflow:cancel',
  workflowRuns: 'workflow:runs',
  workflowSkillDefs: 'workflow:skillDefs',
  /**
   * Feed an external event to the listeners. One door for every transport: the
   * CLI calls it directly, and the Local Web UI's generic `/api/:channel` route
   * makes it the endpoint a Slack app or a git provider webhook posts to.
   */
  workflowEvent: 'workflow:event',
  /** CI runners (T213), served by nekkod's runner supervisor; never by a phone. */
  runnerList: 'runner:list',
  runnerConnect: 'runner:connect',
  runnerUpdate: 'runner:update',
  runnerRemove: 'runner:remove',
  runnerSetEnabled: 'runner:setEnabled',

  connectorsList: 'connectors:list',
  connectorConnect: 'connector:connect',
  connectorDisconnect: 'connector:disconnect',
  connectorFetch: 'connector:fetch',

  integrationsDetect: 'integrations:detect',
  integrationsInstall: 'integrations:install',
  integrationsSnippet: 'integrations:snippet',

  guardrailsClassify: 'guardrails:classify',

  usageSummary: 'usage:summary',
  limitsGet: 'limits:get',
  limitsProblem: 'limits:problem',

  oauthBegin: 'oauth:begin',
  oauthFinish: 'oauth:finish',
  oauthCancel: 'oauth:cancel',
  oauthStatus: 'oauth:status',
  oauthSignOut: 'oauth:signout',
  providersImportCliAuth: 'providers:importCliAuth',

  remoteEnable: 'remote:enable',
  remoteDisable: 'remote:disable',
  remoteStatus: 'remote:status',
  messagingStatus: 'messaging:status',
  remotePairing: 'remote:pairing',
  remotePair: 'remote:pair',
  remoteDevices: 'remote:devices',
  remoteRevoke: 'remote:revoke',
  remoteRename: 'remote:rename',
  remoteRotate: 'remote:rotate',
  // IO-33: a paired phone's Read and Change switches, and its Change activity. Never phone-callable.
  remoteSetAccess: 'remote:setAccess',
  remoteActivity: 'remote:activity',
  // Desktop only: the relay this computer can run on its Tailscale address.
  localRelayStatus: 'localRelay:status',
  localRelayStart: 'localRelay:start',
  localRelayStop: 'localRelay:stop',
  localRelaySetLan: 'localRelay:setLan',
  networkVisibilityStatus: 'networkVisibility:status',
  networkVisibilityStart: 'networkVisibility:start',
  networkVisibilityStop: 'networkVisibility:stop',

  appInfo: 'app:info',
  /** SK-2: a single-use step-up challenge; from a phone the daemon's gate answers it (step-up.ts). */
  securityChallenge: 'security:challenge',
  /** SK-4/SK-5: Settings → Security (step-up-desktop.ts). Desktop and Local Web UI only, never phone-callable. */
  securityStatus: 'security:status',
  securityConfirm: 'security:confirm',
  securityRegisterBegin: 'security:registerBegin',
  securityRegisterKey: 'security:registerKey',
  securityTotpBegin: 'security:totpBegin',
  securityTotpConfirm: 'security:totpConfirm',
  securityEnable: 'security:enable',
  securityDisable: 'security:disable',
  securityRemoveMethod: 'security:removeMethod',
  securityRecoveryCodes: 'security:recoveryCodes',
  /** SK-3 safety exits, phone only: the daemon's phone gate answers them (phone-access.ts). */
  appQuit: 'app:quit',
  deviceSignOut: 'device:signOut',
  remoteStop: 'remote:stop',
  // The Claude policy nekkod enforces, and why a feature is off (claude-policy.ts).
  claudePolicy: 'claude:policy',
  claudeCapability: 'claude:capability',
  claudePlanUsage: 'claude:planUsage',
  claudeCodeStatus: 'claude:codeStatus',
  mcpStatus: 'mcp:status',
  mcpHypergate: 'mcp:hypergate',
  mcpHypergateConnect: 'mcp:hypergate:connect',
  // Transport-local update controls (desktop = electron-updater, web = refresh).
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  // Host-side refresh checks (Settings → Updates "Check now"): model lists + skills.
  updatesCheck: 'updates:check',

  cloudStatus: 'cloud:status',
  cloudRefresh: 'cloud:refresh',
  cloudSendCode: 'cloud:sendCode',
  cloudVerifyCode: 'cloud:verifyCode',
  cloudBeginOAuth: 'cloud:beginOAuth',
  cloudCancelOAuth: 'cloud:cancelOAuth',
  cloudSignOut: 'cloud:signOut',
  syncTurnOn: 'sync:turnOn',
  syncConfirmRecoveryKey: 'sync:confirmRecoveryKey',
  syncRestore: 'sync:restore',
  syncRequestJoin: 'sync:requestJoin',
  syncApprove: 'sync:approve',
  syncRevoke: 'sync:revoke',
  syncNow: 'sync:now',
  syncSetEnabled: 'sync:setEnabled',
  syncSetIncludeLocalOnly: 'sync:setIncludeLocalOnly',
  syncDeleteAll: 'sync:deleteAll',
  // Settings > Connections (crates/nekkod/src/connections.rs).
  connectionsStatus: 'connections:status',
  connectionsEvents: 'connections:events',
  connectionsClear: 'connections:clear',
  // Opt-in usage and crash reports (crates/nekkod/src/telemetry.rs).
  telemetryCapture: 'telemetry:capture',
  telemetryStatus: 'telemetry:status',
  // Send feedback (crates/nekkod/src/feedback.rs): no sign-in needed.
  feedbackInfo: 'feedback:info',
  feedbackSend: 'feedback:send',
  voiceStatus: 'voice:status',
  voiceInstall: 'voice:install',
  voiceCancelInstall: 'voice:cancel',
  voiceUninstall: 'voice:uninstall',
  voiceTranscribe: 'voice:transcribe',
  voicePermission: 'voice:permission',
} as const;

/** Push (main → renderer) channels. */
export const IpcEvents = {
  agentEvent: 'agent:event',
  oauthStatus: 'oauth:status',
  cloudStatus: 'cloud:status',
  indexProgress: 'index:progress',
  updateEvent: 'update:event',
  terminalEvent: 'terminal:event',
  /** A terminal's remote viewers changed (`TerminalViewersEvent`). */
  terminalViewers: 'terminal:viewers',
  changesUpdated: 'changes:updated',
  tasksUpdated: 'tasks:updated',
  /** `BackgroundState` changed: a background turn started, ended, paused or resumed. */
  backgroundUpdated: 'background:updated',
  trainingUpdated: 'training:updated',
  workflowsUpdated: 'workflows:updated',
  /** Every runner's `RunnerView`, after any change. */
  runnerChanged: 'runner:changed',
  limitsUpdated: 'limits:updated',
  /** The look a paired phone mirrors changed: `appearanceOf(settings)`, never anything else. */
  appearanceUpdated: 'appearance:updated',
  downloadsUpdated: 'downloads:updated',
  /** A provider's model list changed in a background refresh. */
  modelsUpdated: 'models:updated',
  /** The skills marketplace catalog refreshed. */
  skillsUpdated: 'skills:updated',
  deepLink: 'app:deepLink',
  /** The screen locked or the computer is going to sleep: stop listening (desktop only). */
  voiceStop: 'voice:stop',
  /** SK-4: a phone signed itself out, stopped remote access or quit the app (`RemoteSafetyExit`). */
  remoteSafetyExit: 'remote:safetyExit',
} as const;

/**
 * What the engine daemon sends a socket that just added a chat to its agent
 * event subscription (`daemon:subscribe`) while the chat's turn runs. Not a
 * host event, so not in `IpcEvents`.
 */
export const AGENT_REPLAY = 'agent:replay';

/** A running turn's events so far: text and reasoning deltas joined, oldest dropped past 4 MB. */
export interface AgentReplay {
  sessionId: string;
  events: AgentEvent[];
  /** When each event arrived (ms since the epoch), parallel to `events`. */
  at: number[];
  /** The oldest events were dropped. */
  truncated: boolean;
}

/** The typed API the preload bridge exposes as window.nekko. */
export interface NekkoApi {
  /** Nekko Cloud sign-in and end-to-end encrypted sync (crates/nekko-cloud). */
  cloudStatus(): Promise<import('./cloud.js').CloudStatus>;
  cloudRefresh(): Promise<import('./cloud.js').CloudStatus>;
  cloudSendCode(email: string): Promise<{ sent: boolean }>;
  cloudVerifyCode(email: string, code: string): Promise<import('./cloud.js').CloudStatus>;
  cloudBeginOAuth(provider: import('./cloud.js').CloudOAuthProvider): Promise<{ authUrl: string }>;
  cloudCancelOAuth(): Promise<import('./cloud.js').CloudStatus>;
  cloudSignOut(): Promise<import('./cloud.js').CloudStatus>;
  /** Settings > Connections: the switch and each connection's counts. */
  connectionsStatus(): Promise<import('./connections.js').ConnectionsStatus>;
  /** A connection's recent events, newest first. */
  connectionsEvents(id: string, limit?: number): Promise<import('./connections.js').ConnectionEvent[]>;
  /** Forget every logged event. */
  connectionsClear(): Promise<import('./connections.js').ConnectionsStatus>;
  /** Opt-in reports: queue a UI event (`screen_viewed`, `feature_used`, `error`); ignored while reports are off. */
  telemetryCapture(event: 'screen_viewed' | 'feature_used' | 'error', props: Record<string, string | number | boolean>): Promise<null>;
  /** Whether reports are on, whether this build has a project to send to, and how many events wait. */
  telemetryStatus(): Promise<{ enabled: boolean; configured: boolean; queued: number }>;
  /** Send feedback: the app facts the sheet may share (app, version, OS, CPU type; nothing identifying). */
  feedbackInfo(): Promise<import('./feedback.js').FeedbackAppInfo>;
  /** Send feedback's quick note to Nekko Cloud, with the facts above only when `includeAppInfo`. */
  feedbackSend(message: string, includeAppInfo: boolean): Promise<{ ok: true }>;
  syncTurnOn(): Promise<import('./cloud.js').SyncTurnOnResult>;
  syncConfirmRecoveryKey(text: string): Promise<import('./cloud.js').CloudStatus>;
  syncRestore(text: string): Promise<import('./cloud.js').CloudStatus>;
  syncRequestJoin(): Promise<{ joinCode: string; status: import('./cloud.js').CloudStatus }>;
  /** Approve a device that asked to join, with the join code its screen shows. */
  syncApprove(deviceId: string, joinCode: string): Promise<import('./cloud.js').CloudStatus>;
  syncRevoke(deviceId: string): Promise<import('./cloud.js').CloudStatus>;
  syncNow(): Promise<import('./cloud.js').CloudStatus>;
  syncSetEnabled(on: boolean): Promise<import('./cloud.js').CloudStatus>;
  syncSetIncludeLocalOnly(on: boolean): Promise<import('./cloud.js').CloudStatus>;
  syncDeleteAll(): Promise<import('./cloud.js').CloudStatus>;
  onCloudStatus(cb: (s: import('./cloud.js').CloudStatus) => void): () => void;
  voiceStatus(): Promise<import('./voice.js').VoiceStatus>;
  voiceInstall(engine?: import('./voice.js').VoiceEngine): Promise<import('./voice.js').VoiceStatus>;
  voiceCancelInstall(): Promise<void>;
  voiceUninstall(engine?: import('./voice.js').VoiceEngine): Promise<void>;
  voiceTranscribe(wav: number[]): Promise<string>;
  voicePermission(action?: 'status' | 'request' | 'settings'): Promise<import('./voice.js').VoicePermission>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  listProviders(): Promise<ProviderConfig[]>;
  saveProvider(p: ProviderConfig): Promise<ProviderConfig[]>;
  removeProvider(id: string): Promise<ProviderConfig[]>;
  discoverProviders(): Promise<ProviderConfig[]>;
  /**
   * Probe well-known localhost ports for running model servers WITHOUT saving
   * anything, unlike discoverProviders which merges hits into settings. The
   * onboarding wizard uses this so a skipped step stays non-destructive and the
   * user picks which detected server to add.
   */
  probeProviders(): Promise<ProviderConfig[]>;
  testProvider(id: string): Promise<{ ok: boolean; message: string }>;
  /** Test an unsaved provider config (used by the add form before saving). */
  testProviderConfig(cfg: ProviderConfig): Promise<{ ok: boolean; message: string }>;

  listModels(providerId: string): Promise<ModelInfo[]>;
  /** listModels plus why it failed: `error` is set when the provider could not list (bad key, timeout). */
  listModelsStatus(providerId: string): Promise<{ models: ModelInfo[]; error?: string }>;
  pullModel(providerId: string, model: string): Promise<{ ok: boolean; message: string }>;
  loadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  unloadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  /** Whether per-model load/unload is available for an LM Studio provider (via `lms`). */
  lmsAvailable(providerId: string): Promise<import('./models.js').LmsProbe>;
  /** Stop the local model server backing a provider (ollama/lmstudio/vllm/…). */
  stopServer(providerId: string): Promise<{ ok: boolean; message: string }>;

  /** Live state of a local runtime: health, ownership, resident models, metrics. */
  runtimeStatus(providerId: string): Promise<import('./runtimes.js').RuntimeStatus | null>;
  /** Start a local runtime we are able to start. Returns the reason when we are not. */
  runtimeStart(
    providerId: string,
  ): Promise<import('./runtimes.js').RuntimeStatus | { error: string }>;
  /**
   * Stop a local runtime. Without `force` this refuses a process Nekko Agent did
   * not start, returning `needsConfirmation` so the UI can ask first.
   */
  runtimeStop(providerId: string, force?: boolean): Promise<import('./runtimes.js').StopResult>;
  /** Load a model with explicit parameters (context, GPU layers, TTL). */
  runtimeLoad(
    providerId: string,
    modelId: string,
    params: import('./runtimes.js').LoadParams,
  ): Promise<import('./runtimes.js').LoadResult>;
  /** Model metadata normalized for the fit planner. */
  runtimeFacts(providerId: string): Promise<import('./capacity.js').ModelFacts[]>;
  /** Project whether a model fits at the given context/parallelism, and why. */
  runtimePlan(
    providerId: string,
    modelId: string,
    req: import('./capacity.js').FitRequest,
  ): Promise<import('./capacity.js').FitPlan | null>;
  /**
   * The simple surface's answer: solve context, GPU layers and KV cache type
   * from one "how much of this machine may it use" fraction, and say in plain
   * words what was chosen and what it costs.
   */
  runtimeAutoFit(
    providerId: string,
    modelId: string,
    budgetFraction: number,
    parallelSlots?: number,
  ): Promise<import('./capacity.js').AutoFitSummary | null>;
  /** Where a load's bytes land: graphics memory, system memory or the SSD. */
  runtimePlace(
    providerId: string,
    modelId: string,
    req: import('./capacity.js').PlacementRequest,
  ): Promise<import('./capacity.js').PlacementPlan | null>;
  /**
   * The fastest setup that fits (`speed`), the most context (`context`), or the
   * lightest split that keeps `request`'s context (`fill`), each choice explained.
   */
  runtimeRecommend(
    providerId: string,
    modelId: string,
    opts?: { goal?: import('./capacity.js').RecommendGoal; request?: import('./capacity.js').PlacementRequest },
  ): Promise<import('./capacity.js').Recommendation | null>;

  /** The built-in engine: install state, server state, resident models. */
  engineStatus(): Promise<import('./engine.js').EngineStatus>;
  /** Download and unpack a llama.cpp build. Always user-initiated. */
  engineInstall(buildId?: string, runtime?: 'llama' | 'diffusion' | 'mlx'): Promise<{ ok: boolean; message: string; jobId?: string }>;
  engineInstallPreview(runtime: 'llama' | 'diffusion' | 'mlx', buildId?: string): Promise<import('./engine.js').EngineInstallPreview | null>;
  engineGenerateImage(request: import('./engine.js').ImageGenerationRequest): Promise<import('./engine.js').ImageGenerationResult>;
  /** Remove a managed engine install. An external binary is never touched. */
  engineUninstall(runtime?: 'llama' | 'diffusion' | 'mlx'): Promise<{ ok: boolean; message: string }>;
  /** Change the engine's server settings; a port or binding change restarts it. */
  engineSettingsSave(
    patch: Partial<import('./engine.js').EngineSettings>,
  ): Promise<import('./engine.js').EngineSettings>;
  /** The local model library, with load state and the planner's residency verdict folded in. */
  engineModels(): Promise<
    Array<import('./engine.js').LocalModel & { loaded: boolean; gpuFit?: import('./engine.js').GpuFit }>
  >;
  /** Adopt a GGUF that lives elsewhere on disk, without copying it. */
  engineImportModel(
    path: string,
  ): Promise<{ ok: boolean; message: string; model?: import('./engine.js').LocalModel }>;
  /** Delete a model file and its library row. */
  engineDeleteModel(id: string): Promise<{ ok: boolean; message: string }>;
  /** Save per-model load settings, applied every time it loads. */
  engineSaveModelPreset(id: string, preset: import('./engine.js').EngineLoadPreset): Promise<void>;
  /** The starter list, or search results when a query is given. */
  /** `format` `mlx` searches MLX checkpoints instead of GGUF repos. */
  engineCatalog(query?: string, format?: 'gguf' | 'mlx'): Promise<import('./engine.js').CatalogModel[]>;
  /** One catalog repo's detail, including every quantization it publishes. */
  engineCatalogModel(id: string): Promise<import('./engine.js').CatalogModel | null>;
  /** The same, plus the model card, for a model's own page. */
  engineCatalogDetail(id: string): Promise<import('./engine.js').CatalogModelDetail | null>;
  /** Where the library looks for models, and what a scan found in each folder. */
  engineFolders(): Promise<import('./engine.js').ModelFolderReport>;
  /** Replace the folder list. The folder downloads land in is not part of it. */
  engineFoldersSave(
    folders: import('./engine.js').ModelFolder[],
  ): Promise<import('./engine.js').ModelFolderReport>;
  /** Start downloading one quantization. Returns immediately; follow the job. */
  engineDownloadModel(
    modelId: string,
    quantLabel: string,
  ): Promise<{ ok: boolean; message: string; jobId?: string }>;
  /**
   * Fetch the files a model already on disk is missing: its projector (vision)
   * and small config sidecars, into a Nekko-owned companions dir. Borrowed
   * folders stay read-only; the engine finds the sidecars at load time.
   */
  engineDownloadCompanions(modelId: string): Promise<{ ok: boolean; message: string }>;
  /** An image model's text encoders and VAE: which it has, which it lacks, and their size. */
  engineImageCompanions(modelId: string): Promise<import('./engine.js').ImageCompanionStatus | null>;
  /** Fetch the text encoders and VAE an image model is missing. */
  engineDownloadImageCompanions(modelId: string): Promise<{ ok: boolean; message: string }>;
  /* Decision models: Laya locally, TypeSafe Jev hosted. */
  decisionsCatalog(): Promise<import('./decisions.js').DecisionCatalogEntry[]>;
  decisionsModels(): Promise<import('./decisions.js').InstalledDecisionModel[]>;
  decisionsDownload(catalogId: string, precision?: import('./decisions.js').DecisionPrecision): Promise<{ ok: boolean; message: string }>;
  decisionsDelete(id: string): Promise<{ ok: boolean; message: string }>;
  decisionsAddFolder(path: string): Promise<{ ok: boolean; message: string }>;
  decisionsStatus(): Promise<import('./decisions.js').DecisionStatus>;
  decisionsLoad(id: string, precision?: import('./decisions.js').DecisionPrecision): Promise<{ ok: boolean; message: string }>;
  decisionsUnload(): Promise<{ ok: boolean; message: string }>;
  decisionsRun(provider: import('./decisions.js').DecisionProvider, request: import('./decisions.js').DecisionRequest): Promise<import('./decisions.js').DecisionResponse>;
  decisionsCheckTypesafe(): Promise<{ ok: boolean; message: string }>;
  /** Set a resident model's idle TTL in seconds (0 keeps it loaded). */
  engineSetResidentTtl(modelId: string, ttlSeconds: number): Promise<{ ok: boolean; message: string }>;
  /** Add or remove a model from the list loaded when the engine starts. */
  engineSetAutoload(modelId: string, enabled: boolean): Promise<import('./engine.js').EngineSettings>;
  /** Everything downloading or recently downloaded. */
  engineDownloads(): Promise<import('./engine.js').DownloadJob[]>;
  engineCancelDownload(id: string): Promise<void>;
  engineDismissDownload(id: string): Promise<void>;

  /**
   * The local API server: this app, reachable by the CLI, an MCP client, or
   * anything else that speaks the same `/api/:channel` surface. Desktop only —
   * the web and self-hosted editions already are that server.
   */
  apiServerStatus(): Promise<import('./api-server.js').ApiServerStatus>;
  /** Save and apply; a change to the port, binding or token restarts it. */
  apiServerSave(
    patch: Partial<import('./api-server.js').ApiServerSettings>,
  ): Promise<import('./api-server.js').ApiServerStatus>;
  /** Roll the bearer token, invalidating whatever was using the old one. */
  apiServerNewToken(): Promise<import('./api-server.js').ApiServerStatus>;

  /**
   * Whether the `nekko-agent` command is installed and reachable. The desktop
   * app links its bundled CLI at first run; this is how the Server tab says
   * whether that worked. Web/self-hosted report `available: false`.
   */
  cliInstallStatus(): Promise<import('./cli-link.js').CliInstallStatus>;
  /** (Re)write the CLI launcher and put its folder on PATH. */
  cliInstall(): Promise<import('./cli-link.js').CliInstallStatus>;

  /**
   * The AN9 machine-readiness report: probe this machine, evaluate it against
   * the versioned offline-stack catalog, and return per-role picks plus a
   * combined verdict. `unverified` means a needed probe did not answer.
   */
  machineReadiness(
    language?: string,
  ): Promise<import('./readiness.js').ReadinessReport>;
  /**
   * This machine's hardware profile: saved and reused for a week, probed
   * again when the engine build changes or `refresh` is set.
   */
  machineProfile(opts?: { refresh?: boolean }): Promise<import('./recommendations.js').HardwareProfile>;
  /** Which model to run for each task here, with expected speed and memory headroom, before any download. */
  machineRecommendations(opts?: { refresh?: boolean }): Promise<import('./recommendations.js').Recommendations>;
  /** Background automations on a local model, and how many are paused for the user (`background:state`). */
  backgroundState(): Promise<import('./background.js').BackgroundState>;
  /** Keep a task's current pick as seen (every task with none), so its upgrade nudge goes. */
  machineDismissNudge(task?: string): Promise<{ ok: boolean }>;
  /** GPU/VRAM stats for the metrics bar + Agent board (null if unavailable). */
  getGpuStats(): Promise<import('./models.js').GpuStats | null>;
  /** CPU load + RAM use for the monitor surfaces (null if unavailable). */
  getSystemStats(): Promise<import('./monitor.js').SystemStats | null>;

  listSessions(): Promise<Session[]>;
  /** Earliest deadline of this chat's active durable watches, or null. */
  nextAgentWatchAt(sessionId: string): Promise<number | null>;
  /** This chat's durable watches as the UI shows them; never their continuation prompts. */
  cancelAgentWatch(sessionId: string, id: string): Promise<void>;
  listAgentWatches(sessionId: string): Promise<import('./chat.js').AgentWatchView[]>;
  /**
   * Every chat without its transcript: what the sidebar, the board and the
   * insights read. Cheap enough to call on every refresh; `getSession` fetches
   * a transcript when a chat is opened.
   */
  listSessionSummaries(): Promise<import('./session-summary.js').SessionSummary[]>;
  configureSandbox(sessionId: string, image: string): Promise<import('./chat.js').SandboxStatus>;
  cleanupSandbox(sessionId: string, identity: string): Promise<void>;
  sandboxStatus(sessionId: string): Promise<import('./chat.js').SandboxStatus>;
  sandboxDiff(sessionId: string): Promise<import('./chat.js').SandboxDiff>;
  applySandboxDiff(sessionId: string, identity: string, diffId: string, paths: string[]): Promise<never>;
  createSession(workspaceId?: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  setSessionWorkspace(sessionId: string, workspaceId?: string): Promise<Session | null>;
  setSessionSupportingWorkspaces(sessionId: string, workspaceIds: string[]): Promise<Session | null>;
  setSessionAttachments(sessionId: string, paths: string[]): Promise<Session | null>;
  sendChat(opts: SendOptions): Promise<void>;
  /** One image-generation turn: the prompt and the picture are appended to the chat. */
  generateImageTurn(opts: import('./chat.js').ImageTurnOptions): Promise<void>;
  /** The newest pictures an image chat made, newest last, keyed by message id. */
  sessionImages(sessionId: string, limit: number): Promise<Array<{ messageId: string; src: string }>>;
  abortChat(sessionId: string): Promise<void>;
  compactSession(sessionId: string, opts?: { newChat?: boolean }): Promise<Session>;
  cancelSessionCompaction(sessionId: string): Promise<void>;
  /** Append a prompt to a chat's run-queue (runs when the current turn ends). */
  queuePrompt(sessionId: string, input: string | import('./chat.js').QueuePayload): Promise<Session | null>;
  /** Remove a queued prompt by index. */
  dequeuePrompt(sessionId: string, index: number): Promise<Session | null>;
  /**
   * Steer the reply that is running: the text joins the transcript at the next
   * tool boundary, so the model sees it without the turn being stopped. A chat
   * that is not running queues it instead.
   */
  steerChat(sessionId: string, text: string): Promise<Session | null>;
  /** Stop active work, then start the selected queued prompt on the chosen model. Resolves when its turn ends. */
  interruptQueuedPrompt(sessionId: string, index: number, brain?: { providerId: string; modelId: string }): Promise<void>;
  /**
   * Model-written next-step ideas for a chat that just answered: a few short
   * follow-ups for one-click chips plus the single most likely next message
   * (shown as composer ghost text). A sideband call on the chat's own provider
   * and model; null when there is nothing to suggest from (no reply yet,
   * unattended run, no usable provider). Never persists anything.
   */
  suggestReplies(sessionId: string): Promise<ReplySuggestions | null>;
  resourceQueue(action: string, input?: Record<string, unknown>): Promise<unknown>;
  /**
   * Model-drafted snippet for a prompt part the composer is missing (the
   * analyzer's click-to-fill chips). A sideband call on the chat's own provider
   * and model; null when there is no usable provider or the model returns
   * nothing usable, in which case the deterministic starter text is the
   * fallback. Never persists anything.
   */
  fillPromptPart(sessionId: string, part: string, draft: string): Promise<string | null>;
  approveTool(sessionId: string, toolCallId: string, approved: boolean): Promise<void>;
  /**
   * Answer an `ask_user` call, which unblocks the turn that asked. Passing no
   * answers is a refusal to answer: the agent is told to pick and carry on
   * rather than left waiting.
   */
  answerQuestion(
    sessionId: string,
    callId: string,
    answers: import('./ask.js').AskAnswer[],
  ): Promise<void>;
  /**
   * Every session currently waiting on a person, keyed by session id. The board
   * reads this on mount so a question asked while it was closed is still there.
   */
  pendingInput(): Promise<Record<string, PendingInput>>;
  /** The chats whose turn is running right now, so a screen that opens mid-run shows them working at once. */
  runningSessions(): Promise<string[]>;

  /** Live terminal sessions (in-memory; they don't persist across restarts); `sessionId` narrows to one chat's. */
  listTerminals(filter?: { sessionId?: string }): Promise<TerminalInfo[]>;
  /** Shells the host detected as available to launch. */
  listShells(): Promise<ShellOption[]>;
  /** Spawn a PTY-backed shell, optionally scoped to a project / cwd / shell. */
  /** `claudeAccount`: run `claude` there on that Claude Code account (sets `CLAUDE_CONFIG_DIR`; a checked name, never a path). */
  createTerminal(opts?: { workspaceId?: string; sessionId?: string; cwd?: string; title?: string; shell?: string; cols?: number; rows?: number; claudeAccount?: string }): Promise<TerminalInfo>;
  /** Fetch current info + retained raw scrollback (for reattaching a renderer); `maxBytes` keeps only the tail. */
  terminalSnapshot(id: string, opts?: { maxBytes?: number }): Promise<TerminalSnapshot | null>;
  /** Host aliases from the computer's ~/.ssh/config (display fields only). */
  listSshHosts?(): Promise<SshHost[]>;
  /** Open a terminal running `ssh <alias>` for a host from `listSshHosts`. */
  openSsh?(alias: string, opts?: { cols?: number; rows?: number; sessionId?: string; workspaceId?: string }): Promise<TerminalInfo>;
  /** Update a terminal's project/order (sidebar drag-and-drop). */
  updateTerminal(id: string, patch: { workspaceId?: string | null; order?: number; title?: string }): Promise<void>;
  /** Write raw input (keystrokes) to the PTY. */
  writeTerminal(id: string, data: string): Promise<void>;
  /** Tell the PTY its new viewport size so the shell reflows. */
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  /** Convenience: write a command line followed by Enter. */
  runInTerminal(id: string, command: string): Promise<void>;
  /** Send a control signal (e.g. interrupt → Ctrl-C). */
  signalTerminal(id: string, signal: 'interrupt'): Promise<void>;
  /** Kill the shell and forget the terminal. */
  closeTerminal(id: string): Promise<void>;

  previewContext(sessionId: string, attachedPaths: string[]): Promise<ContextBundle>;
  toggleContextItem(sessionId: string, itemId: string, included: boolean, pinned: boolean): Promise<ContextBundle>;
  setContextPrefs(sessionId: string, prefs: import('./chat.js').ContextPrefs): Promise<void>;

  /** Build/refresh the primary spec doc in the chat's workspace from the conversation. */
  buildSpec(sessionId: string): Promise<{ ok: boolean; path?: string; message?: string }>;
  /** Build/refresh one artifact (by id) of the chat's spec methodology. */
  buildSpecDoc(sessionId: string, docId?: string, workspaceId?: string): Promise<{ ok: boolean; path?: string; docId?: string; message?: string }>;
  /** Read the live status of every artifact in the chat's spec methodology. */
  readSpecDocs(sessionId: string, workspaceId?: string): Promise<{ methodologyId: string; docs: import('./spec.js').SpecDocStatus[] }>;
  /** Set the spec methodology for a chat. */
  setSpecMethodology(sessionId: string, methodologyId: string): Promise<void>;
  /** Toggle a checklist item in the chat's tasks artifact. */
  toggleSpecTask(sessionId: string, lineIndex: number, workspaceId?: string): Promise<{ ok: boolean; message?: string }>;
  setSpecLinked(sessionId: string, linked: boolean): Promise<Session | null>;
  specPath(sessionId: string): Promise<string | null>;
  setSessionOptions(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'order' | 'mode' | 'disabledTools' | 'effort' | 'disabledMcpServers' | 'disabledConnectors' | 'memory' | 'guidance' | 'toolApproach' | 'offline' | 'cloudOnly' | 'incognito' | 'executionMode' | 'gitIsolation' | 'autoModel' | 'autoQuality' | 'autoProviderSwitch' | 'workMode' | 'thinking' | 'providerId' | 'modelId' | 'plan' | 'chatType' | 'imageParams' | 'archivedAt' | 'privacy'>>,
  ): Promise<Session | null>;
  truncateSession(id: string, messageId: string): Promise<Session | null>;
  /** Delete chats within a window; returns how many were removed. */
  clearSessions(scope: import('./chat.js').ChatClearScope): Promise<number>;
  /** Compatibility no-op: completed history is retained indefinitely. */
  purgeExpiredArchives(): Promise<number>;
  /** All local chat JSON and command-log bytes; count is completed chats only. Symlinks are not followed. */
  getHistoryUsage(): Promise<{ bytes: number; count: number }>;
  /** Delete completed chats in the selected updatedAt range; returns how many were removed. */
  clearHistory(range: 'today' | 'last-week' | 'older-2-weeks' | 'older-1-month' | 'older-6-months'): Promise<number>;
  /** A new chat with this one's conversation before `beforeMessageId` (all of it when omitted). */
  forkSession(id: string, beforeMessageId?: string): Promise<Session | null>;
  /** Reset all settings to defaults (keeps chats). */
  resetSettings(): Promise<AppSettings>;
  /** The fonts folder (created if missing) and the font files in it, base64 (Settings > Style). */
  listFonts(): Promise<{ dir: string; fonts: { family: string; file: string; data: string }[] }>;
  /** Delete everything: chats, settings, memory, and usage. */
  wipeAllData(): Promise<AppSettings>;
  listTools(): Promise<Array<{ name: string; description: string }>>;

  /** Open a native file picker (desktop) → chosen paths; browser → prompt. */
  openFilesDialog(): Promise<string[]>;
  /**
   * The on-disk path of a File the user dropped or pasted, when the OS handed
   * one over (a file copied in Explorer or Finder). Empty for a pasted blob
   * with no home, such as an image copied from a browser; see importAttachment.
   */
  pathForFile(file: File): string;
  /**
   * Save pasted bytes under the app's data dir so they can be attached like any
   * other file. Returns the saved path. `dataUrl` is a `data:<mime>;base64,` URL.
   */
  importAttachment(sessionId: string, name: string, dataUrl: string): Promise<string>;
  /** Reveal/open a path with the OS (desktop) or a URL (web). */
  openPath(path: string): Promise<void>;

  listMemory(scope: MemoryScope, workspaceId?: string): Promise<MemoryEntry[]>;
  saveMemory(entry: MemoryEntry): Promise<MemoryEntry[]>;
  deleteMemory(id: string): Promise<void>;

  listWorkspaces(): Promise<WorkspaceFolder[]>;
  /** Ask the user for a folder; null when cancelled. Registers nothing. */
  pickFolder(): Promise<string | null>;
  addWorkspace(): Promise<WorkspaceFolder[]>;
  addWorkspaceByPath(path: string): Promise<WorkspaceFolder[]>;
  removeWorkspace(id: string): Promise<WorkspaceFolder[]>;
  indexWorkspace(id: string): Promise<IndexStatus>;
  getIndexStatus(id: string): Promise<IndexStatus | null>;
  searchWorkspace(id: string, query: string): Promise<SearchHit[]>;
  listFiles(id: string): Promise<IndexedFile[]>;
  /**
   * Which branch a workspace folder is on, how dirty it is, and how far it has
   * drifted from its upstream. A folder that is not a repository answers
   * `repo: false` rather than failing. Cached host-side, so polling it per
   * sidebar card is cheap; pass `force` to bypass that cache.
   */
  getGitStatus(id: string, force?: boolean): Promise<import('./workspace.js').GitStatus>;
  /** Every chat's isolated worktree across the configured projects, including deleted chats'. */
  listChatWorktrees(): Promise<import('./workspace.js').ChatWorktreeInfo[]>;
  /**
   * Remove a chat worktree's folder. Refused while the chat runs or the folder
   * has uncommitted changes; the branch is deleted only when fully merged.
   */
  removeChatWorktree(root: string): Promise<{ branchDeleted: boolean }>;

  /** Read a file as text (for the in-app viewer/editor). */
  readFile(path: string): Promise<FileContent>;
  /** Write text to a file (in-app editor save). */
  writeFile(path: string, content: string): Promise<void>;
  /** List a directory's immediate entries (file explorer). */
  listDir(path: string): Promise<DirEntry[]>;
  /**
   * Scoped file access for remote callers (IO-33 FA-1): the folder is named
   * by chat or saved-folder id, paths are relative to it, escapes and
   * secret-looking files are refused. See {@link ScopedRoot}.
   */
  listScopedFiles(root: ScopedRoot, relPath: string): Promise<ScopedListing>;
  /** Files whose name (then path) holds `query`; gitignored files left out. */
  searchScopedFiles(root: ScopedRoot, query: string, limit?: number): Promise<ScopedSearch>;
  readScopedFile(root: ScopedRoot, relPath: string, opts?: { maxBytes?: number }): Promise<ScopedFile>;
  /**
   * Save text only if the file still has `expectHash` (null: only if it does
   * not exist yet); otherwise `{ ok: false, error: 'conflict', hash }`.
   */
  writeScopedFile(root: ScopedRoot, relPath: string, content: string, opts: { expectHash: string | null }): Promise<ScopedWriteResult>;
  /** The computer's logs: app, engine and each chat's agent run log (IO-33 FA-5). */
  listLogs(): Promise<LogInfo[]>;
  /** A log's redacted tail, or its redacted lines that hold `query`. */
  readLog(id: string, opts?: LogReadOptions): Promise<LogRead>;
  /** What Privacy Shield would replace before this chat's next request reaches a cloud model. */
  previewPrivacy(sessionId: string, draft: string): Promise<import('./privacy.js').PrivacyPreview>;
  /**
   * Fetch a remote photo for the chat through the host: public http(s) only,
   * size-capped and type-sniffed, returned as an inert data URL.
   */
  fetchRemoteImage(url: string): Promise<RemoteImage>;

  /** Files the agent changed this session (diff/approve). */
  listChanges(sessionId: string): Promise<FileChange[]>;
  /** Keep a file's changes, stop tracking it. */
  acceptChange(sessionId: string, path: string): Promise<void>;
  /** Keep all of a session's changes. */
  acceptAllChanges(sessionId: string): Promise<void>;

  /** Live PR state for every GitHub PR URL referenced in a chat's transcript. */
  listSessionPrs(sessionId: string, force?: boolean): Promise<import('./pr.js').PrInfo[]>;
  /** A PR's changed files + patches (for the diff pane). */
  getPrDiff(url: string): Promise<import('./pr.js').PrDiff>;
  /** Approve / decline / merge / reopen a PR. Always user-initiated. */
  prAction(url: string, action: import('./pr.js').PrAction): Promise<import('./pr.js').PrActionResult>;
  continuePrStack(sessionId: string, url: string): Promise<Session>;
  linkPrStack(sessionId: string, url: string): Promise<import('./pr.js').PrActionResult>;
  /** Open a PR from the workspace's current (pushed) branch, with gh or the GitHub token. */
  createPr(workspaceId: string, opts: import('./pr.js').PrCreateOptions): Promise<import('./pr.js').PrCreateResult>;
  /** Each check on a PR's head commit, and their rollup. */
  getPrChecks(url: string): Promise<import('./pr.js').PrCheckList>;

  /**
   * Git in a workspace's folder (IO-33 FA-2). `workspaceId` is a saved folder's
   * id or `session:<chatId>`. Paths are relative to the folder. Changes answer
   * `{ ok: false, message }` when git refuses; nothing force-pushes, amends or
   * skips hooks. Each change drops the folder's cached `getGitStatus`.
   */
  gitDiff(workspaceId: string, opts?: import('./git.js').GitDiffOptions): Promise<import('./git.js').GitDiff>;
  gitLog(workspaceId: string, opts?: import('./git.js').GitLogOptions): Promise<import('./git.js').GitCommit[]>;
  gitShow(workspaceId: string, sha: string): Promise<import('./git.js').GitCommitDetail>;
  gitBranches(workspaceId: string): Promise<import('./git.js').GitBranches>;
  gitCompare(workspaceId: string, base: string, head: string): Promise<import('./git.js').GitCompare>;
  gitStage(workspaceId: string, paths: string[]): Promise<import('./git.js').GitResult>;
  gitUnstage(workspaceId: string, paths: string[]): Promise<import('./git.js').GitResult>;
  gitCommit(workspaceId: string, opts: import('./git.js').GitCommitOptions): Promise<import('./git.js').GitCommitResult>;
  /** A commit message for what is staged, from the default provider and model. */
  gitCommitMessage(workspaceId: string): Promise<import('./git.js').GitCommitMessage>;
  gitPush(workspaceId: string, opts?: import('./git.js').GitPushOptions): Promise<import('./git.js').GitPushResult>;
  gitSwitch(workspaceId: string, branch: string, opts?: import('./git.js').GitSwitchOptions): Promise<import('./git.js').GitSwitchResult>;
  /** Back out of a conflicted merge; `ok: false` when none is in progress. */
  gitMergeAbort(workspaceId: string): Promise<import('./git.js').GitResult>;

  /** Inline editor comments on a file (gutter "+" annotations the agent picks up). */
  listComments(path: string): Promise<LineComment[]>;
  addComment(path: string, line: number, lineText: string, comment: string): Promise<LineComment[]>;
  resolveComment(path: string, id: string): Promise<LineComment[]>;

  /** Design board: a workspace's UI page snapshots + persistent notes. */
  getDesignBoard(workspaceId: string): Promise<DesignBoard>;
  addDesignPage(workspaceId: string, label: string, url: string): Promise<DesignBoard>;
  updateDesignPage(workspaceId: string, pageId: string, patch: Partial<Pick<DesignPage, 'label' | 'url' | 'html'>>): Promise<DesignBoard>;
  removeDesignPage(workspaceId: string, pageId: string): Promise<DesignBoard>;
  addDesignNote(workspaceId: string, pageId: string, text: string): Promise<DesignBoard>;
  resolveDesignNote(workspaceId: string, pageId: string, noteId: string): Promise<DesignBoard>;
  /** Generate (or refine) an AI design concept from a prompt and/or a sketch. */
  generateDesign(workspaceId: string, input: GenerateDesignInput): Promise<DesignBoard>;

  /** Skills marketplace: what's installed, where installs can go, install/remove. */
  listInstalledSkills(): Promise<import('./skills-market.js').InstalledSkillRecord[]>;
  listExternalSkills(): Promise<import('./skills.js').SkillDef[]>;
  skillTargets(): Promise<import('./skills-market.js').InstallTargetInfo[]>;
  installSkill(
    skillId: string,
    target: import('./skills-market.js').InstallTarget,
    payload?: import('./skills-market.js').MarketplaceSkill,
  ): Promise<{ ok: boolean; message?: string; installed: import('./skills-market.js').InstalledSkillRecord[] }>;
  uninstallSkill(
    skillId: string,
    target: import('./skills-market.js').InstallTarget,
  ): Promise<import('./skills-market.js').InstalledSkillRecord[]>;
  /** Vaizer skills hub (optional integration): catalog + SKILL.md fetch. */
  vaizerCatalog(refresh?: boolean): Promise<import('./vaizer.js').VaizerCatalog>;
  vaizerSkillMd(slug: string): Promise<string | null>;
  /**
   * Skills from GitHub. `listSkillSources` reads the cache unless `refresh`
   * (true = every shelf, a repo = that one); preview/fetch/search use the network.
   */
  listSkillSources(refresh?: boolean | string): Promise<import('./skill-sources.js').SkillSourceListing[]>;
  previewSkillUrl(input: string): Promise<import('./skill-sources.js').SkillPreview>;
  fetchRemoteSkill(skill: import('./skill-sources.js').RemoteSkill): Promise<import('./skill-sources.js').SkillFetchResult>;
  searchSkills(query: string): Promise<import('./skill-sources.js').SkillSearchResult>;

  /** Automation tasks: scheduled, recurring, and long-running background agents. */
  listTasks(): Promise<AutomationTask[]>;
  createTask(task: NewTask): Promise<AutomationTask[]>;
  updateTask(id: string, patch: Partial<AutomationTask>): Promise<AutomationTask[]>;
  deleteTask(id: string): Promise<AutomationTask[]>;
  runTaskNow(id: string): Promise<void>;

  /** Training/goal runs: the data-scientist agent + experiment tree engine. */
  listTrainingRuns(): Promise<TrainingRun[]>;
  createTrainingRun(input: NewTrainingRun): Promise<TrainingRun>;
  updateTrainingRun(id: string, patch: Partial<TrainingRun>): Promise<TrainingRun[]>;
  deleteTrainingRun(id: string): Promise<TrainingRun[]>;
  startTrainingRun(id: string): Promise<TrainingRun[]>;
  pauseTrainingRun(id: string): Promise<TrainingRun[]>;
  stopTrainingRun(id: string): Promise<TrainingRun[]>;
  /** Inject a hint / new approach / new-data pointer into the next turn. */
  addTrainingHint(id: string, text: string): Promise<TrainingRun[]>;

  /** Workflows: GitHub-Actions-style automation with routed steps and triggers. */
  listWorkflows(): Promise<WorkflowsSnapshot>;
  createWorkflow(input: NewWorkflow): Promise<Workflow | undefined>;
  updateWorkflow(id: string, patch: Partial<Workflow>): Promise<Workflow | undefined>;
  deleteWorkflow(id: string): Promise<WorkflowsSnapshot>;
  duplicateWorkflow(id: string): Promise<Workflow | undefined>;
  /** Start a workflow by hand; resolves when the run finishes. */
  runWorkflow(id: string): Promise<WorkflowRun | undefined>;
  /** Stop a run in progress (aborts whatever step is mid-flight). */
  cancelWorkflowRun(runId: string): Promise<void>;
  /** Run history, newest first, for one workflow or all of them. */
  listWorkflowRuns(workflowId?: string): Promise<WorkflowRun[]>;
  /** Every skill a workflow's skill step can run, built-in first, then installs, other tools' and Claude Code plugins'. */
  listWorkflowSkillDefs(): Promise<import('./skills.js').SkillDef[]>;
  /** Offer an event to every listening workflow; returns the runs it started. */
  dispatchWorkflowEvent(event: WorkflowEvent): Promise<WorkflowRun[]>;
  /** CI runners on this Mac. Rejects where the daemon serves none (not macOS, or an older daemon). */
  listRunners(): Promise<RunnerView[]>;
  connectRunner(req: ConnectRequest): Promise<RunnerView>;
  /** Resolves with the settings the daemon kept, which may be clamped. */
  /** A patch: only the keys to change. */
  updateRunner(id: string, settings: Partial<RunnerSettings>): Promise<RunnerView>;
  removeRunner(id: string): Promise<null>;
  setRunnerEnabled(id: string, enabled: boolean): Promise<RunnerView>;

  listConnectors(): Promise<ConnectorConfig[]>;
  connectConnector(kind: ConnectorKind, token: string, settings?: Record<string, string>): Promise<ConnectorConfig[]>;
  disconnectConnector(kind: ConnectorKind): Promise<ConnectorConfig[]>;
  fetchConnector(kind: ConnectorKind, query?: string): Promise<ConnectorResource[]>;

  /** Which agent CLIs are present and whether Nekko is installed as an MCP subagent. */
  detectAgentTools(): Promise<AgentToolStatus[]>;
  /**
   * Merge the nekko-agent MCP entry into a tool's config (backs up to
   * <file>.bak first). The desktop transport points the entry at this app's
   * running server; pass a target to override what it writes.
   */
  installSubagent(tool: AgentToolId, target?: SubagentTarget): Promise<SubagentInstallResult>;
  /** The manual copy-paste config for a tool (target path + snippet). */
  subagentSnippet(tool: AgentToolId, target?: SubagentTarget): Promise<SubagentSnippet>;

  classifyCommand(command: string): Promise<import('./guardrails.js').GuardrailDecision>;
  saveGuardrail(rule: GuardrailRule): Promise<GuardrailRule[]>;

  getUsageSummary(): Promise<UsageSummary>;
  getLimits(tokenKey: string, refresh?: boolean): Promise<SubscriptionLimits | undefined>;
  /** Why the last quota read for this key failed, when it did. */
  getLimitsProblem(tokenKey: string): Promise<import('./limits.js').LimitsProblem | undefined>;

  oauthBegin(provider: OAuthProvider): Promise<OAuthSessionInfo>;
  oauthFinish(sessionId: string, pasted: string): Promise<OAuthStatus>;
  oauthCancel(sessionId: string): Promise<void>;
  oauthStatus(providerConfigId: string): Promise<OAuthStatus>;
  oauthSignOut(providerConfigId: string): Promise<void>;
  /** Import tokens from the official CLI credential files without returning the secrets. */
  importCliAuth(): Promise<Record<OAuthProvider, boolean>>;

  enableRemote(relayUrl: string): Promise<import('./remote.js').RemoteStatus>;
  disableRemote(): Promise<import('./remote.js').RemoteStatus>;
  getRemoteStatus(): Promise<import('./remote.js').RemoteStatus>;
  /** Inbound messaging channels (Telegram bot, …): live per-channel state. */
  getMessagingStatus(): Promise<import('./messaging.js').MessagingStatus>;
  getRemotePairing(): Promise<import('./remote.js').RemotePairing | null>;
  /** Mint a short-lived single-use pairing code for enrolling a new device. */
  startRemotePairing(): Promise<import('./remote.js').PairingGrant>;
  listRemoteDevices(): Promise<import('./remote.js').RemoteDevice[]>;
  revokeRemoteDevice(deviceId: string): Promise<import('./remote.js').RemoteDevice[]>;
  renameRemoteDevice(deviceId: string, name: string): Promise<import('./remote.js').RemoteDevice[]>;
  /** Rotate the pairing secret: re-keys the room; every device must re-pair. */
  rotateRemoteSecret(): Promise<import('./remote.js').RemoteStatus>;
  /** Turn a paired phone's Read or Change access on or off (IO-33). Returns every device. */
  setRemoteAccess(deviceId: string, access: { read?: boolean; change?: boolean }): Promise<import('./remote.js').RemoteDevice[]>;
  /** A paired phone's Change actions, oldest first, allowed or refused (IO-33). */
  getRemoteActivity(deviceId: string): Promise<import('./phone-access.js').PhoneActivityEntry[]>;
  /**
   * The relay this computer runs itself, bound to its Tailscale address, so
   * phones on the tailnet reach it with nothing in between. Desktop only.
   */
  localRelayStatus(): Promise<import('./relay-route.js').LocalRelayStatus>;
  /** Switch it on (and keep it on across restarts); reports why if it can't start. */
  localRelayStart(): Promise<import('./relay-route.js').LocalRelayStatus>;
  localRelayStop(): Promise<import('./relay-route.js').LocalRelayStatus>;
  /** Also listen on this computer's private LAN addresses (on by default). Desktop only. */
  localRelaySetLan(on: boolean): Promise<import('./relay-route.js').LocalRelayStatus>;
  /**
   * "Visible on this network": answer mDNS for `_nekko-agent._tcp` so phones
   * on the same Wi-Fi can list this computer. Off by default; says nothing
   * that gets a phone into the room. Desktop only.
   */
  networkVisibilityStatus(): Promise<import('./relay-route.js').NetworkVisibilityStatus>;
  networkVisibilityStart(): Promise<import('./relay-route.js').NetworkVisibilityStatus>;
  networkVisibilityStop(): Promise<import('./relay-route.js').NetworkVisibilityStatus>;

  /**
   * Settings → Security (SK-4, SK-5; step-up-desktop.ts). Optional: only the
   * desktop app and the Local Web UI have them.
   */
  securityStatus?(): Promise<import('./step-up-desktop.js').SecurityStatus>;
  securityChallenge?(): Promise<import('./step-up-desktop.js').DesktopStepUpChallenge>;
  /** Answer the step-up sheet for an action class: covers it on this surface for five minutes. */
  securityConfirm?(action: string, proof: import('./step-up-desktop.js').DesktopStepUpProof): Promise<import('./step-up-desktop.js').StepUpConfirmed>;
  securityRegisterBegin?(kind: import('./step-up.js').SecurityCredentialKind): Promise<import('./step-up-desktop.js').SecurityRegisterBegin>;
  securityRegisterKey?(input: import('./step-up-desktop.js').SecurityRegisterKeyInput): Promise<import('./step-up-desktop.js').SecurityMethodAdded>;
  securityTotpBegin?(): Promise<import('./step-up-desktop.js').SecurityTotpBegin>;
  securityTotpConfirm?(code: string): Promise<import('./step-up-desktop.js').SecurityMethodAdded>;
  securityEnable?(): Promise<import('./step-up-desktop.js').SecurityStatus>;
  /** Turn step-up off: any registered method, or a recovery code. */
  securityDisable?(proof: import('./step-up-desktop.js').DesktopStepUpProof | null): Promise<import('./step-up-desktop.js').SecurityStatus>;
  /** Remove a key (its id) or the code app (`totp`): with step-up on, a different method or a recovery code. */
  securityRemoveMethod?(id: string, proof: import('./step-up-desktop.js').DesktopStepUpProof | null): Promise<import('./step-up-desktop.js').SecurityStatus>;
  /** Ten new recovery codes, shown once; the old ones stop working. */
  securityRecoveryCodes?(): Promise<string[]>;
  /**
   * Run a WebAuthn ceremony where WebAuthn works: in the page itself in a
   * browser, in a loopback ceremony window on the desktop.
   */
  webAuthnCeremony?(request: import('./step-up-desktop.js').WebAuthnCeremonyRequest): Promise<import('./step-up-desktop.js').WebAuthnCeremonyResult>;
  /**
   * Who answers a `step-up-required` refusal: the page's step-up sheet. The
   * transport calls it with the refused action class and, when it resolves
   * true (confirmed), calls again once.
   */
  setStepUpHandler?(handler: ((action: string | null, message: string) => Promise<boolean>) | null): void;

  /** Running version + edition. */
  getAppInfo(): Promise<AppInfo>;
  /** The Claude policy nekkod enforces (shipped table, signed override, dev preview). */
  getClaudePolicy(): Promise<import('./claude-policy.js').ClaudePolicyStatus>;
  /** One provider's row for a Claude capability, with the reason line when it is off. */
  getClaudeCapability(providerId: string, capability: import('./claude-policy.js').ClaudeCapability): Promise<import('./claude-policy.js').ClaudeCapabilityStatus>;
  /** Plan usage for a Claude provider: none today; example data in the dev-only preview. */
  getClaudePlanUsage(providerId: string): Promise<import('./claude-policy.js').ClaudePlanUsageStatus>;
  /**
   * Whether the user's Claude Code is installed and signed in; records it for
   * `providerId`'s policy rows. Before a provider is saved, `account` names the
   * Claude Code account to check (none: the default login).
   */
  getClaudeCodeStatus(providerId?: string, account?: string): Promise<import('./claude-policy.js').ClaudeCodeStatus>;
  /** Connect configured MCP servers and return their status + tools. */
  getMcpStatus(): Promise<import('./mcp.js').McpServerStatus[]>;
  /** Probe for a local Hypergate daemon (`hypergated`) and return its gateway info. */
  detectHypergate(port?: number): Promise<import('./mcp.js').HypergateInfo | null>;
  /** Connect to a local Hypergate daemon: claim a token, save the entry, bring its tools online. */
  connectHypergate(port?: number): Promise<import('./mcp.js').HypergateInfo | null>;
  /** Register this device's push token with the relay (mobile/relay only; no-op elsewhere). */
  registerPushToken(token: string, platform: 'ios' | 'android'): Promise<void>;
  /** Check for a newer version (desktop: GitHub feed; web: server version). */
  checkForUpdates(): Promise<UpdateInfo>;
  /** Download the available update (desktop only; web resolves immediately). */
  downloadUpdate(): Promise<UpdateInfo>;
  /** Install + relaunch (desktop) or reload the page (web). */
  quitAndInstall(): Promise<void>;
  /**
   * Run the host's refresh checks now, ignoring the toggles: provider model
   * lists and the skills catalog. Resolves when the checks have run; changes
   * arrive as `modelsUpdated`/`skillsUpdated`.
   */
  runUpdateChecks(): Promise<void>;

  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  /**
   * Take the agent event stream of these chats only (null: every chat's, the
   * default). Every chat's summary events still arrive: a turn's first event,
   * a wait on a person and the event after it, `session_meta`, `compaction`,
   * `done` and `error` (crates/nekkod/src/hub.rs). A chat added while its turn
   * runs is sent what it missed through `onAgentReplay`. Absent, or a no-op,
   * where the engine has no daemon.
   */
  subscribeAgentEvents?(sessionIds: string[] | null): void;
  /** A running turn's events so far, for a chat just added to `subscribeAgentEvents`. */
  onAgentReplay?(cb: (r: AgentReplay) => void): () => void;
  onOAuthStatus(cb: (s: OAuthStatus) => void): () => void;
  onIndexProgress(cb: (s: IndexStatus) => void): () => void;
  onUpdateEvent(cb: (u: UpdateInfo) => void): () => void;
  onTerminalEvent(cb: (e: import('./terminal.js').TerminalEvent) => void): () => void;
  /** A terminal's remote viewers changed (a phone attached or left). */
  onTerminalViewers?(cb: (e: import('./terminal.js').TerminalViewersEvent) => void): () => void;
  /**
   * One terminal's raw byte stream straight from the engine daemon, with
   * flow control: output arrives at most once per frame, and a flood waits
   * for `ack` instead of piling up. Resolves null where there is no daemon
   * (the Local Web UI, or the desktop app running without one); callers then
   * use `onTerminalEvent` and `writeTerminal`.
   */
  openTerminalStream?(
    id: string,
    handlers: import('./terminal.js').TerminalStreamHandlers,
  ): Promise<import('./terminal.js').TerminalStream | null>;
  /** Fires when a session's tracked file changes shift (after an agent edit/accept). */
  onChangesUpdated(cb: (e: { sessionId: string }) => void): () => void;
  /** Fires when the automation-task list changes (created/updated/fired/deleted). */
  onTasksUpdated(cb: (tasks: AutomationTask[]) => void): () => void;
  onBackgroundUpdated(cb: (state: import('./background.js').BackgroundState) => void): () => void;
  /** Fires when any training/goal run changes (experiments, hints, status). */
  onTrainingUpdated(cb: (runs: TrainingRun[]) => void): () => void;
  /** Fires when a workflow is edited or any run advances a step. */
  onWorkflowsUpdated(cb: (snapshot: WorkflowsSnapshot) => void): () => void;
  onRunnersChanged(cb: (views: RunnerView[]) => void): () => void;
  /** Fires when subscription limits are captured or polled for any token key. */
  onLimitsUpdated(cb: (e: { tokenKey: string; limits: SubscriptionLimits }) => void): () => void;
  /** Fires as engine and model downloads progress, finish, or fail. */
  onDownloadsUpdated(cb: (jobs: import('./engine.js').DownloadJob[]) => void): () => void;
  /** Fires when a background refresh found a changed provider model list. */
  onModelsUpdated(cb: (e: { providerId: string }) => void): () => void;
  /** Fires when the skills marketplace catalog refreshed to a new skill set. */
  onSkillsUpdated(cb: (catalog: import('./vaizer.js').VaizerCatalog) => void): () => void;
  /**
   * Fires when another app asks Nekko Agent to do something through an `nekko-agent://`
   * URL: today, Hypergate's "Connect Nekko Agent" button. Desktop only, since the
   * web transport has no OS to hand it one.
   */
  onDeepLink(cb: (url: string) => void): () => void;
  /** Fires when the screen locks or the computer sleeps, so dictation stops. Desktop only. */
  onVoiceStop(cb: () => void): () => void;
}
