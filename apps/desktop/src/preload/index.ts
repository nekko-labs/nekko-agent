import { setChatOptionsAndDefaults, settingsPatchWithModeReset } from '../chatDefaults.js';
import { NOTIFICATION_VISIBILITY_CHANNEL } from '../notificationVisibility.js';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { PREVIEW_CHANNEL } from '../previewPolicy.js';
if (process.isMainFrame) contextBridge.exposeInMainWorld('nekkoPreview', { open: (source: string) => ipcRenderer.invoke(PREVIEW_CHANNEL, source) });
import type {
  AppSettings,
  ConnectorKind,
  GuardrailRule,
  MemoryEntry,
  MemoryScope,
  NekkoApi,
  ProviderConfig,
  SendOptions,
  AgentEvent,
  AgentReplay,
  IndexStatus,
  UpdateInfo,
  TerminalEvent,
  TerminalViewersEvent,
  OAuthStatus,
  SubscriptionLimits,
} from '@nekko-agent/shared';
import { AGENT_REPLAY, IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { ENGINE_ENDPOINT_CHANNEL, PICK_FOLDER_CHANNEL, SERVICE_CONTROL_CHANNEL } from '../engineChannels.js';
import { createEngineSocket, type Listener } from './engine-socket.js';
import { MAIN_EVENTS } from './routing.js';
import { withStepUpRetry, type StepUpHandler } from '../stepUpRetry.js';
import { WEBAUTHN_CEREMONY_CHANNEL } from '../webauthnCeremony.js';
import {
  TITLEBAR_HEIGHT,
  TITLEBAR_OVERLAY_CHANNEL,
  type TitleBarOverlayTheme,
  type WindowChromeBridge,
} from '../windowChrome.js';
import {
  DISPLAY_ARG, DISPLAYS_CHANGED_EVENT, DISPLAYS_CLAIM_CHANNEL, DISPLAYS_LIST_CHANNEL, DISPLAYS_PLACED_EVENT,
  DISPLAYS_PLACEMENT_CHANNEL, DISPLAYS_REPORT_CHANNEL, DISPLAYS_TOGGLE_CHANNEL, type DisplaysState,
  DISPLAYS_DESKTOP_CHANNEL, DISPLAYS_GO_CHANNEL, DISPLAYS_SPACES_MODE_CHANNEL,
} from '../displayWindows.js';

// Every call goes to the engine's socket (see `routing.ts`).
const engine = createEngineSocket((operation) => ipcRenderer.invoke(ENGINE_ENDPOINT_CHANNEL, operation));

/** The page's step-up sheet (SK-4), set by the renderer through `setStepUpHandler`. */
let stepUpHandler: StepUpHandler | null = null;

/** A call to the engine; a guarded one refused `step-up-required` opens the sheet and runs again once confirmed. */
const inv = (channel: string, ...args: unknown[]): Promise<any> => withStepUpRetry(() => engine.call(channel, args), () => stepUpHandler);

/** Events: main's few from `ipcRenderer`, the rest from the engine. */
const bus = {
  on: (channel: string, listener: Listener) => {
    if (MAIN_EVENTS.has(channel)) ipcRenderer.on(channel, listener);
    else engine.on(channel, listener);
  },
  removeListener: (channel: string, listener: Listener) => {
    if (MAIN_EVENTS.has(channel)) ipcRenderer.removeListener(channel, listener);
    else engine.off(channel, listener);
  },
};

const api: NekkoApi = {
  getSettings: () => inv(IpcChannels.settingsGet),
  updateSettings: (patch) => inv(IpcChannels.settingsUpdate, settingsPatchWithModeReset(patch)),

  listProviders: () => inv(IpcChannels.providersList),
  saveProvider: (p: ProviderConfig) => inv(IpcChannels.providersSave, p),
  removeProvider: (id) => inv(IpcChannels.providersRemove, id),
  discoverProviders: () => inv(IpcChannels.providersDiscover),
  probeProviders: () => inv(IpcChannels.providersProbe),
  testProvider: (id) => inv(IpcChannels.providersTest, id),
  testProviderConfig: (cfg) => inv(IpcChannels.providersTestConfig, cfg),

  listModels: (providerId) => inv(IpcChannels.modelsList, providerId),
  listModelsStatus: (providerId) => inv(IpcChannels.modelsListStatus, providerId),
  pullModel: (providerId, model) => inv(IpcChannels.modelPull, providerId, model),
  loadModel: (providerId, model) => inv(IpcChannels.modelLoad, providerId, model),
  unloadModel: (providerId, model) => inv(IpcChannels.modelUnload, providerId, model),
  lmsAvailable: (providerId) => inv(IpcChannels.lmsProbe, providerId),
  stopServer: (providerId) => inv(IpcChannels.serverStop, providerId),
  runtimeStatus: (providerId) => inv(IpcChannels.runtimeStatus, providerId),
  runtimeStart: (providerId) => inv(IpcChannels.runtimeStart, providerId),
  runtimeStop: (providerId, force) => inv(IpcChannels.runtimeStop, providerId, force),
  runtimeLoad: (providerId, modelId, params) => inv(IpcChannels.runtimeLoad, providerId, modelId, params),
  runtimeFacts: (providerId) => inv(IpcChannels.runtimeFacts, providerId),
  runtimePlan: (providerId, modelId, req) => inv(IpcChannels.runtimePlan, providerId, modelId, req),
  runtimeAutoFit: (providerId, modelId, budgetFraction, parallelSlots) =>
    inv(IpcChannels.runtimeAutoFit, providerId, modelId, budgetFraction, parallelSlots),
  runtimePlace: (providerId, modelId, req) => inv(IpcChannels.runtimePlace, providerId, modelId, req),
  runtimeRecommend: (providerId, modelId, opts) => inv(IpcChannels.runtimeRecommend, providerId, modelId, opts),
  cloudStatus: () => inv(IpcChannels.cloudStatus),
  cloudRefresh: () => inv(IpcChannels.cloudRefresh),
  cloudSendCode: (email) => inv(IpcChannels.cloudSendCode, email),
  cloudVerifyCode: (email, code) => inv(IpcChannels.cloudVerifyCode, email, code),
  cloudBeginOAuth: (provider) => inv(IpcChannels.cloudBeginOAuth, provider),
  cloudCancelOAuth: () => inv(IpcChannels.cloudCancelOAuth),
  cloudSignOut: () => inv(IpcChannels.cloudSignOut),
  connectionsStatus: () => inv(IpcChannels.connectionsStatus),
  connectionsEvents: (id, limit) => inv(IpcChannels.connectionsEvents, id, limit),
  connectionsClear: () => inv(IpcChannels.connectionsClear),
  telemetryCapture: (event, props) => inv(IpcChannels.telemetryCapture, event, props),
  telemetryStatus: () => inv(IpcChannels.telemetryStatus),
  feedbackInfo: () => inv(IpcChannels.feedbackInfo),
  feedbackSend: (message, includeAppInfo) => inv(IpcChannels.feedbackSend, message, includeAppInfo),
  syncTurnOn: () => inv(IpcChannels.syncTurnOn),
  syncConfirmRecoveryKey: (text) => inv(IpcChannels.syncConfirmRecoveryKey, text),
  syncRestore: (text) => inv(IpcChannels.syncRestore, text),
  syncRequestJoin: () => inv(IpcChannels.syncRequestJoin),
  syncApprove: (deviceId, joinCode) => inv(IpcChannels.syncApprove, deviceId, joinCode),
  syncRevoke: (deviceId) => inv(IpcChannels.syncRevoke, deviceId),
  syncNow: () => inv(IpcChannels.syncNow),
  syncSetEnabled: (on) => inv(IpcChannels.syncSetEnabled, on),
  syncSetIncludeLocalOnly: (on) => inv(IpcChannels.syncSetIncludeLocalOnly, on),
  syncDeleteAll: () => inv(IpcChannels.syncDeleteAll),
  voiceStatus: () => inv(IpcChannels.voiceStatus),
  voiceInstall: (engine) => inv(IpcChannels.voiceInstall, engine),
  voiceCancelInstall: () => inv(IpcChannels.voiceCancelInstall),
  voiceUninstall: (engine) => inv(IpcChannels.voiceUninstall, engine),
  voiceTranscribe: (wav) => inv(IpcChannels.voiceTranscribe, wav),
  voicePermission: (action) => inv(IpcChannels.voicePermission, action),
  engineStatus: () => inv(IpcChannels.engineStatus),
  engineInstall: (buildId, runtime) => inv(IpcChannels.engineInstall, buildId, runtime),
  engineUninstall: (runtime) => inv(IpcChannels.engineUninstall, runtime),
  engineInstallPreview: (runtime, buildId) => inv(IpcChannels.engineInstallPreview, runtime, buildId),
  engineGenerateImage: (request) => inv(IpcChannels.engineGenerateImage, request),
  engineSettingsSave: (patch) => inv(IpcChannels.engineSettingsSave, patch),
  engineModels: () => inv(IpcChannels.engineModels),
  engineImportModel: (path) => inv(IpcChannels.engineImportModel, path),
  engineDeleteModel: (id) => inv(IpcChannels.engineDeleteModel, id),
  engineSaveModelPreset: (id, preset) => inv(IpcChannels.engineSaveModelPreset, id, preset),
  engineCatalog: (query, format) => inv(IpcChannels.engineCatalog, query, format),
  engineCatalogModel: (id) => inv(IpcChannels.engineCatalogModel, id),
  engineCatalogDetail: (id) => inv(IpcChannels.engineCatalogDetail, id),
  engineFolders: () => inv(IpcChannels.engineFolders),
  engineFoldersSave: (folders) => inv(IpcChannels.engineFoldersSave, folders),
  engineDownloadModel: (modelId, quantLabel) => inv(IpcChannels.engineDownloadModel, modelId, quantLabel),
  engineDownloadCompanions: (modelId) => inv(IpcChannels.engineDownloadCompanions, modelId),
  engineImageCompanions: (modelId) => inv(IpcChannels.engineImageCompanions, modelId),
  engineDownloadImageCompanions: (modelId) => inv(IpcChannels.engineDownloadImageCompanions, modelId),
  decisionsCatalog: () => inv(IpcChannels.decisionsCatalog),
  decisionsModels: () => inv(IpcChannels.decisionsModels),
  decisionsDownload: (catalogId, precision) => inv(IpcChannels.decisionsDownload, catalogId, precision),
  decisionsDelete: (id) => inv(IpcChannels.decisionsDelete, id),
  decisionsAddFolder: (path) => inv(IpcChannels.decisionsAddFolder, path),
  decisionsStatus: () => inv(IpcChannels.decisionsStatus),
  decisionsLoad: (id, precision) => inv(IpcChannels.decisionsLoad, id, precision),
  decisionsUnload: () => inv(IpcChannels.decisionsUnload),
  decisionsRun: (provider, request) => inv(IpcChannels.decisionsRun, provider, request),
  decisionsCheckTypesafe: () => inv(IpcChannels.decisionsCheckTypesafe),
  engineSetResidentTtl: (modelId, ttlSeconds) => inv(IpcChannels.engineSetResidentTtl, modelId, ttlSeconds),
  engineSetAutoload: (modelId, enabled) => inv(IpcChannels.engineSetAutoload, modelId, enabled),
  engineDownloads: () => inv(IpcChannels.engineDownloads),
  engineCancelDownload: (id) => inv(IpcChannels.engineCancelDownload, id),
  engineDismissDownload: (id) => inv(IpcChannels.engineDismissDownload, id),
  apiServerStatus: () => inv(IpcChannels.apiServerStatus),
  apiServerSave: (patch) => inv(IpcChannels.apiServerSave, patch),
  apiServerNewToken: () => inv(IpcChannels.apiServerNewToken),
  cliInstallStatus: () => inv(IpcChannels.cliInstallStatus),
  cliInstall: () => inv(IpcChannels.cliInstall),
  machineReadiness: (language) => inv(IpcChannels.machineReadiness, language),
  machineProfile: (opts) => inv(IpcChannels.machineProfile, opts),
  machineRecommendations: (opts) => inv(IpcChannels.machineRecommendations, opts),
  backgroundState: () => inv(IpcChannels.backgroundState),
  machineDismissNudge: (task) => inv(IpcChannels.machineDismissNudge, task ?? null),
  getGpuStats: () => inv(IpcChannels.gpuStats),
  getSystemStats: () => inv(IpcChannels.systemStats),

  listSessions: () => inv(IpcChannels.sessionsList),
  nextAgentWatchAt: (sessionId) => inv(IpcChannels.sessionNextWatch, sessionId),
  listAgentWatches: (sessionId) => inv(IpcChannels.sessionWatches, sessionId),
  listSessionSummaries: () => inv(IpcChannels.sessionsSummaries),
  createSession: (workspaceId) => inv(IpcChannels.sessionCreate, workspaceId),
  getSession: (id) => inv(IpcChannels.sessionGet, id),
  deleteSession: (id) => inv(IpcChannels.sessionDelete, id),
  setSessionWorkspace: (sessionId, workspaceId) => inv(IpcChannels.sessionSetWorkspace, sessionId, workspaceId),
  setSessionSupportingWorkspaces: (sessionId, workspaceIds) => inv(IpcChannels.sessionSetSupportingWorkspaces, sessionId, workspaceIds),
  setSessionAttachments: (sessionId, paths) => inv(IpcChannels.sessionSetAttachments, sessionId, paths),
  sendChat: (opts: SendOptions) => inv(IpcChannels.chatSend, opts),
  generateImageTurn: (opts) => inv(IpcChannels.chatGenerateImage, opts),
  sessionImages: (sessionId, limit) => inv(IpcChannels.sessionImages, sessionId, limit),
  abortChat: (sessionId) => inv(IpcChannels.chatAbort, sessionId),
  compactSession: (sessionId, opts) => inv(IpcChannels.chatCompact, sessionId, opts),
  cancelSessionCompaction: (sessionId) => inv(IpcChannels.chatCancelCompaction, sessionId),
  queuePrompt: (sessionId, text) => inv(IpcChannels.chatQueue, sessionId, text),
  dequeuePrompt: (sessionId, index) => inv(IpcChannels.chatDequeue, sessionId, index),
  steerChat: (sessionId, text) => inv(IpcChannels.chatSteer, sessionId, text),
  interruptQueuedPrompt: (sessionId, index, brain) => inv(IpcChannels.chatInterruptQueued, sessionId, index, brain),
  resourceQueue: (action, input) => inv(IpcChannels.resourceQueue, action, input),
  suggestReplies: (sessionId) => inv(IpcChannels.chatSuggest, sessionId),
  fillPromptPart: (sessionId, part, draft) => inv(IpcChannels.chatFillPrompt, sessionId, part, draft),
  approveTool: (sessionId, toolCallId, approved) => inv(IpcChannels.toolApprove, sessionId, toolCallId, approved),
  answerQuestion: (sessionId, callId, answers) => inv(IpcChannels.chatAnswer, sessionId, callId, answers),
  pendingInput: () => inv(IpcChannels.chatPending),
  runningSessions: () => inv(IpcChannels.chatRunning),

  listTerminals: (filter) => (filter ? inv(IpcChannels.terminalsList, filter) : inv(IpcChannels.terminalsList)),
  listShells: () => inv(IpcChannels.terminalShells),
  createTerminal: (opts) => inv(IpcChannels.terminalCreate, opts),
  terminalSnapshot: (id, opts) => (opts ? inv(IpcChannels.terminalSnapshot, id, opts) : inv(IpcChannels.terminalSnapshot, id)),
  listSshHosts: () => inv(IpcChannels.sshHosts),
  openSsh: (alias, opts) => inv(IpcChannels.sshOpen, alias, opts ?? {}),
  updateTerminal: (id, patch) => inv(IpcChannels.terminalUpdate, id, patch),
  writeTerminal: (id, data) => inv(IpcChannels.terminalWrite, id, data),
  resizeTerminal: (id, cols, rows) => inv(IpcChannels.terminalResize, id, cols, rows),
  runInTerminal: (id, command) => inv(IpcChannels.terminalRun, id, command),
  signalTerminal: (id, signal) => inv(IpcChannels.terminalSignal, id, signal),
  closeTerminal: (id) => inv(IpcChannels.terminalClose, id),

  previewContext: (sessionId, attachedPaths) => inv(IpcChannels.contextPreview, sessionId, attachedPaths),
  toggleContextItem: (sessionId, itemId, included, pinned) =>
    inv(IpcChannels.contextToggle, sessionId, itemId, included, pinned),
  setContextPrefs: (sessionId, prefs) => inv(IpcChannels.contextSetPrefs, sessionId, prefs),

  buildSpec: (sessionId) => inv(IpcChannels.specBuild, sessionId),
  buildSpecDoc: (sessionId, docId, workspaceId) => inv(IpcChannels.specBuildDoc, sessionId, docId, workspaceId),
  readSpecDocs: (sessionId, workspaceId) => inv(IpcChannels.specReadDocs, sessionId, workspaceId),
  setSpecMethodology: (sessionId, methodologyId) => inv(IpcChannels.specSetMethodology, sessionId, methodologyId),
  toggleSpecTask: (sessionId, lineIndex, workspaceId) => inv(IpcChannels.specToggleTask, sessionId, lineIndex, workspaceId),
  setSpecLinked: (sessionId, linked) => inv(IpcChannels.specSetLinked, sessionId, linked),
  specPath: (sessionId) => inv(IpcChannels.specPath, sessionId),
  configureSandbox: (id, image) => inv(IpcChannels.sandboxConfigure, id, image),
  cleanupSandbox: (id, identity) => inv(IpcChannels.sandboxCleanup, id, identity),
  sandboxStatus: (id) => inv(IpcChannels.sandboxStatus, id),
  sandboxDiff: (id) => inv(IpcChannels.sandboxDiff, id),
  applySandboxDiff: (id, identity, diffId, paths) => inv(IpcChannels.sandboxApplyDiff, id, identity, diffId, paths) as Promise<never>,
  setSessionOptions: (id, patch) => setChatOptionsAndDefaults({
    setSessionOptions: (id, patch) => inv(IpcChannels.sessionSetOptions, id, patch),
    updateSettings: (patch) => inv(IpcChannels.settingsUpdate, settingsPatchWithModeReset(patch)),
  }, id, patch),
  truncateSession: (id, messageId) => inv(IpcChannels.sessionTruncate, id, messageId),
  clearSessions: (scope) => inv(IpcChannels.sessionsClear, scope),
  purgeExpiredArchives: () => inv(IpcChannels.sessionsPurgeArchived),
  forkSession: (id, beforeMessageId) => inv(IpcChannels.sessionFork, id, beforeMessageId),
  resetSettings: () => inv(IpcChannels.settingsReset),
  listFonts: () => inv(IpcChannels.fontsList),
  wipeAllData: () => inv(IpcChannels.dataWipe),
  listTools: () => inv(IpcChannels.toolsList),

  openFilesDialog: () => inv(IpcChannels.dialogOpenFiles),
  // Electron hides File.path from the sandboxed renderer; webUtils is the
  // sanctioned way to learn where a dropped or pasted file lives on disk.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  importAttachment: (sessionId, name, dataUrl) => inv(IpcChannels.attachmentImport, sessionId, name, dataUrl),
  openPath: (path) => inv(IpcChannels.openPath, path),

  listMemory: (scope: MemoryScope, workspaceId) => inv(IpcChannels.memoryList, scope, workspaceId),
  saveMemory: (entry: MemoryEntry) => inv(IpcChannels.memorySave, entry),
  deleteMemory: (id) => inv(IpcChannels.memoryDelete, id),

  listWorkspaces: () => inv(IpcChannels.workspaceList),
  // The picker is native (the daemon's, owned by this window); adding the folder is the engine's.
  pickFolder: () => inv(PICK_FOLDER_CHANNEL),
  addWorkspace: async () => {
    const path: string | null = await inv(PICK_FOLDER_CHANNEL);
    return path ? inv(IpcChannels.workspaceAddByPath, path) : inv(IpcChannels.workspaceList);
  },
  addWorkspaceByPath: (path) => inv(IpcChannels.workspaceAddByPath, path),
  removeWorkspace: (id) => inv(IpcChannels.workspaceRemove, id),
  indexWorkspace: (id) => inv(IpcChannels.workspaceIndex, id),
  getIndexStatus: (id) => inv(IpcChannels.workspaceIndexStatus, id),
  searchWorkspace: (id, query) => inv(IpcChannels.workspaceSearch, id, query),
  listFiles: (id) => inv(IpcChannels.workspaceFiles, id),
  getGitStatus: (id, force) => inv(IpcChannels.workspaceGitStatus, id, force),
  listChatWorktrees: () => inv(IpcChannels.chatWorktreesList),
  removeChatWorktree: (root) => inv(IpcChannels.chatWorktreesRemove, root),

  readFile: (path) => inv(IpcChannels.fileRead, path),
  writeFile: (path, content) => inv(IpcChannels.fileWrite, path, content),
  listDir: (path) => inv(IpcChannels.dirList, path),
  listScopedFiles: (root, relPath) => inv(IpcChannels.filesList, root, relPath),
  searchScopedFiles: (root, query, limit) => inv(IpcChannels.filesSearch, root, query, limit),
  readScopedFile: (root, relPath, opts) => inv(IpcChannels.filesRead, root, relPath, opts ?? {}),
  writeScopedFile: (root, relPath, content, opts) => inv(IpcChannels.filesWrite, root, relPath, content, opts),
  listLogs: () => inv(IpcChannels.logsList),
  previewPrivacy: (sessionId, draft) => inv(IpcChannels.privacyPreview, sessionId, draft),
  readLog: (id, opts) => inv(IpcChannels.logsRead, id, opts ?? {}),
  fetchRemoteImage: (url) => inv(IpcChannels.imageFetch, url),

  listChanges: (sessionId) => inv(IpcChannels.changesList, sessionId),
  acceptChange: (sessionId, path) => inv(IpcChannels.changeAccept, sessionId, path),
  acceptAllChanges: (sessionId) => inv(IpcChannels.changeAcceptAll, sessionId),

  listSessionPrs: (sessionId, force) => inv(IpcChannels.prSessionList, sessionId, force),
  getPrDiff: (url) => inv(IpcChannels.prDiff, url),
  prAction: (url, action) => inv(IpcChannels.prAction, url, action),
  continuePrStack: (sessionId, url) => inv(IpcChannels.prContinueStack, sessionId, url),
  linkPrStack: (sessionId, url) => inv(IpcChannels.prLinkStack, sessionId, url),
  createPr: (workspaceId, opts) => inv(IpcChannels.prCreate, workspaceId, opts),
  getPrChecks: (url) => inv(IpcChannels.prChecks, url),

  gitDiff: (workspaceId, opts) => inv(IpcChannels.gitDiff, workspaceId, opts),
  gitLog: (workspaceId, opts) => inv(IpcChannels.gitLog, workspaceId, opts),
  gitShow: (workspaceId, sha) => inv(IpcChannels.gitShow, workspaceId, sha),
  gitBranches: (workspaceId) => inv(IpcChannels.gitBranches, workspaceId),
  gitCompare: (workspaceId, base, head) => inv(IpcChannels.gitCompare, workspaceId, base, head),
  gitStage: (workspaceId, paths) => inv(IpcChannels.gitStage, workspaceId, paths),
  gitUnstage: (workspaceId, paths) => inv(IpcChannels.gitUnstage, workspaceId, paths),
  gitCommit: (workspaceId, opts) => inv(IpcChannels.gitCommit, workspaceId, opts),
  gitCommitMessage: (workspaceId) => inv(IpcChannels.gitCommitMessage, workspaceId),
  gitPush: (workspaceId, opts) => inv(IpcChannels.gitPush, workspaceId, opts),
  gitSwitch: (workspaceId, branch, opts) => inv(IpcChannels.gitSwitch, workspaceId, branch, opts),
  gitMergeAbort: (workspaceId) => inv(IpcChannels.gitMergeAbort, workspaceId),

  listComments: (path) => inv(IpcChannels.commentsList, path),
  addComment: (path, line, lineText, comment) => inv(IpcChannels.commentAdd, path, line, lineText, comment),
  resolveComment: (path, id) => inv(IpcChannels.commentResolve, path, id),

  getDesignBoard: (workspaceId) => inv(IpcChannels.designGet, workspaceId),
  addDesignPage: (workspaceId, label, url) => inv(IpcChannels.designAddPage, workspaceId, label, url),
  updateDesignPage: (workspaceId, pageId, patch) => inv(IpcChannels.designUpdatePage, workspaceId, pageId, patch),
  removeDesignPage: (workspaceId, pageId) => inv(IpcChannels.designRemovePage, workspaceId, pageId),
  addDesignNote: (workspaceId, pageId, text) => inv(IpcChannels.designAddNote, workspaceId, pageId, text),
  resolveDesignNote: (workspaceId, pageId, noteId) => inv(IpcChannels.designResolveNote, workspaceId, pageId, noteId),
  generateDesign: (workspaceId, input) => inv(IpcChannels.designGenerate, workspaceId, input),

  listInstalledSkills: () => inv(IpcChannels.skillsInstalled),
  listExternalSkills: () => inv(IpcChannels.skillsExternal),
  skillTargets: () => inv(IpcChannels.skillsTargets),
  installSkill: (skillId, target, payload) => inv(IpcChannels.skillInstall, skillId, target, payload),
  uninstallSkill: (skillId, target) => inv(IpcChannels.skillUninstall, skillId, target),
  vaizerCatalog: (refresh) => inv(IpcChannels.vaizerCatalog, refresh),
  listSkillSources: (refresh) => inv(IpcChannels.skillSourcesList, refresh),
  previewSkillUrl: (input) => inv(IpcChannels.skillSourcesPreview, input),
  fetchRemoteSkill: (skill) => inv(IpcChannels.skillSourcesFetch, skill),
  searchSkills: (query) => inv(IpcChannels.skillSourcesSearch, query),
  vaizerSkillMd: (slug) => inv(IpcChannels.vaizerSkillMd, slug),

  listTasks: () => inv(IpcChannels.tasksList),
  createTask: (task) => inv(IpcChannels.taskCreate, task),
  updateTask: (id, patch) => inv(IpcChannels.taskUpdate, id, patch),
  deleteTask: (id) => inv(IpcChannels.taskDelete, id),
  runTaskNow: (id) => inv(IpcChannels.taskRunNow, id),

  listTrainingRuns: () => inv(IpcChannels.trainingList),
  createTrainingRun: (input) => inv(IpcChannels.trainingCreate, input),
  updateTrainingRun: (id, patch) => inv(IpcChannels.trainingUpdate, id, patch),
  deleteTrainingRun: (id) => inv(IpcChannels.trainingDelete, id),
  startTrainingRun: (id) => inv(IpcChannels.trainingStart, id),
  pauseTrainingRun: (id) => inv(IpcChannels.trainingPause, id),
  stopTrainingRun: (id) => inv(IpcChannels.trainingStop, id),
  addTrainingHint: (id, text) => inv(IpcChannels.trainingHint, id, text),

  listWorkflows: () => inv(IpcChannels.workflowsList),
  createWorkflow: (input) => inv(IpcChannels.workflowCreate, input),
  updateWorkflow: (id, patch) => inv(IpcChannels.workflowUpdate, id, patch),
  deleteWorkflow: (id) => inv(IpcChannels.workflowDelete, id),
  duplicateWorkflow: (id) => inv(IpcChannels.workflowDuplicate, id),
  runWorkflow: (id) => inv(IpcChannels.workflowRun, id),
  cancelWorkflowRun: (runId) => inv(IpcChannels.workflowCancel, runId),
  listWorkflowRuns: (workflowId) => inv(IpcChannels.workflowRuns, workflowId),
  listWorkflowSkillDefs: () => inv(IpcChannels.workflowSkillDefs),
  dispatchWorkflowEvent: (event) => inv(IpcChannels.workflowEvent, event),
  listRunners: () => inv(IpcChannels.runnerList),
  connectRunner: (req) => inv(IpcChannels.runnerConnect, req),
  updateRunner: (id, settings) => inv(IpcChannels.runnerUpdate, id, settings),
  removeRunner: (id) => inv(IpcChannels.runnerRemove, id),
  setRunnerEnabled: (id, enabled) => inv(IpcChannels.runnerSetEnabled, id, enabled),

  listConnectors: () => inv(IpcChannels.connectorsList),
  connectConnector: (kind: ConnectorKind, token, settings) => inv(IpcChannels.connectorConnect, kind, token, settings),
  disconnectConnector: (kind: ConnectorKind) => inv(IpcChannels.connectorDisconnect, kind),
  fetchConnector: (kind: ConnectorKind, query) => inv(IpcChannels.connectorFetch, kind, query),

  detectAgentTools: () => inv(IpcChannels.integrationsDetect),
  installSubagent: (tool, target) => inv(IpcChannels.integrationsInstall, tool, target),
  subagentSnippet: (tool, target) => inv(IpcChannels.integrationsSnippet, tool, target),

  classifyCommand: (command) => inv(IpcChannels.guardrailsClassify, command),
  saveGuardrail: async (rule: GuardrailRule) => {
    const settings: AppSettings = await inv(IpcChannels.settingsGet);
    const guardrails = settings.guardrails.filter((g) => g.id !== rule.id);
    guardrails.push(rule);
    const updated: AppSettings = await inv(IpcChannels.settingsUpdate, { guardrails });
    return updated.guardrails;
  },

  getUsageSummary: () => inv(IpcChannels.usageSummary),
  getLimits: (tokenKey: string, refresh?: boolean) => inv(IpcChannels.limitsGet, tokenKey, refresh),
  getLimitsProblem: (tokenKey: string) => inv(IpcChannels.limitsProblem, tokenKey),

  oauthBegin: (provider) => inv(IpcChannels.oauthBegin, provider),
  oauthFinish: (sessionId, pasted) => inv(IpcChannels.oauthFinish, sessionId, pasted),
  oauthCancel: (sessionId) => inv(IpcChannels.oauthCancel, sessionId),
  oauthStatus: (providerConfigId) => inv(IpcChannels.oauthStatus, providerConfigId),
  oauthSignOut: (providerConfigId) => inv(IpcChannels.oauthSignOut, providerConfigId),
  importCliAuth: () => inv(IpcChannels.providersImportCliAuth),

  enableRemote: (relayUrl) => inv(IpcChannels.remoteEnable, relayUrl),
  disableRemote: () => inv(IpcChannels.remoteDisable),
  getRemoteStatus: () => inv(IpcChannels.remoteStatus),
  getMessagingStatus: () => inv(IpcChannels.messagingStatus),
  getRemotePairing: () => inv(IpcChannels.remotePairing),
  startRemotePairing: () => inv(IpcChannels.remotePair),
  listRemoteDevices: () => inv(IpcChannels.remoteDevices),
  revokeRemoteDevice: (deviceId) => inv(IpcChannels.remoteRevoke, deviceId),
  renameRemoteDevice: (deviceId, name) => inv(IpcChannels.remoteRename, deviceId, name),
  rotateRemoteSecret: () => inv(IpcChannels.remoteRotate),
  setRemoteAccess: (deviceId, access) => inv(IpcChannels.remoteSetAccess, deviceId, access),
  getRemoteActivity: (deviceId) => inv(IpcChannels.remoteActivity, deviceId),
  localRelayStatus: () => inv(IpcChannels.localRelayStatus),
  localRelayStart: () => inv(IpcChannels.localRelayStart),
  localRelayStop: () => inv(IpcChannels.localRelayStop),
  localRelaySetLan: (on) => inv(IpcChannels.localRelaySetLan, on),
  networkVisibilityStatus: () => inv(IpcChannels.networkVisibilityStatus),
  networkVisibilityStart: () => inv(IpcChannels.networkVisibilityStart),
  networkVisibilityStop: () => inv(IpcChannels.networkVisibilityStop),
  // Settings → Security (SK-4): the engine verifies; WebAuthn runs in main's loopback ceremony window.
  securityStatus: () => inv(IpcChannels.securityStatus),
  securityChallenge: () => inv(IpcChannels.securityChallenge),
  securityConfirm: (action, proof) => inv(IpcChannels.securityConfirm, action, proof),
  securityRegisterBegin: (kind) => inv(IpcChannels.securityRegisterBegin, kind),
  securityRegisterKey: (input) => inv(IpcChannels.securityRegisterKey, input),
  securityTotpBegin: () => inv(IpcChannels.securityTotpBegin),
  securityTotpConfirm: (code) => inv(IpcChannels.securityTotpConfirm, code),
  securityEnable: () => inv(IpcChannels.securityEnable),
  securityDisable: (proof) => inv(IpcChannels.securityDisable, proof),
  securityRemoveMethod: (id, proof) => inv(IpcChannels.securityRemoveMethod, id, proof),
  securityRecoveryCodes: () => inv(IpcChannels.securityRecoveryCodes),
  webAuthnCeremony: (request) => ipcRenderer.invoke(WEBAUTHN_CEREMONY_CHANNEL, request),
  setStepUpHandler: (handler) => { stepUpHandler = handler; },

  getAppInfo: () => inv(IpcChannels.appInfo),
  getClaudePolicy: () => inv(IpcChannels.claudePolicy),
  getClaudeCapability: (providerId, capability) => inv(IpcChannels.claudeCapability, providerId, capability),
  getClaudePlanUsage: (providerId) => inv(IpcChannels.claudePlanUsage, providerId),
  getClaudeCodeStatus: (providerId, account) => inv(IpcChannels.claudeCodeStatus, providerId, account),
  getMcpStatus: () => inv(IpcChannels.mcpStatus),
  detectHypergate: (port?: number) => inv(IpcChannels.mcpHypergate, port),
  connectHypergate: (port?: number) => inv(IpcChannels.mcpHypergateConnect, port),
  registerPushToken: () => Promise.resolve(), // desktop isn't a relay client
  checkForUpdates: () => inv(IpcChannels.updateCheck),
  downloadUpdate: () => inv(IpcChannels.updateDownload),
  quitAndInstall: () => inv(IpcChannels.updateInstall),
  runUpdateChecks: () => inv(IpcChannels.updatesCheck),

  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const listener = (_: unknown, e: AgentEvent) => cb(e);
    bus.on(IpcEvents.agentEvent, listener);
    return () => bus.removeListener(IpcEvents.agentEvent, listener);
  },
  subscribeAgentEvents: (sessionIds) => engine.subscribe(sessionIds),
  onAgentReplay: (cb) => {
    const listener = (_: unknown, r: AgentReplay) => cb(r);
    bus.on(AGENT_REPLAY, listener);
    return () => bus.removeListener(AGENT_REPLAY, listener);
  },
  onCloudStatus: (cb) => {
    const listener = (_: unknown, s: import('@nekko-agent/shared').CloudStatus) => cb(s);
    bus.on(IpcEvents.cloudStatus, listener);
    return () => bus.removeListener(IpcEvents.cloudStatus, listener);
  },
  onOAuthStatus: (cb: (s: OAuthStatus) => void) => {
    const listener = (_: unknown, s: OAuthStatus) => cb(s);
    bus.on(IpcEvents.oauthStatus, listener);
    return () => bus.removeListener(IpcEvents.oauthStatus, listener);
  },
  onIndexProgress: (cb: (s: IndexStatus) => void) => {
    const listener = (_: unknown, s: IndexStatus) => cb(s);
    bus.on(IpcEvents.indexProgress, listener);
    return () => bus.removeListener(IpcEvents.indexProgress, listener);
  },
  onUpdateEvent: (cb: (u: UpdateInfo) => void) => {
    const listener = (_: unknown, u: UpdateInfo) => cb(u);
    bus.on(IpcEvents.updateEvent, listener);
    return () => bus.removeListener(IpcEvents.updateEvent, listener);
  },
  onTerminalEvent: (cb: (e: TerminalEvent) => void) => {
    const listener = (_: unknown, e: TerminalEvent) => cb(e);
    bus.on(IpcEvents.terminalEvent, listener);
    return () => bus.removeListener(IpcEvents.terminalEvent, listener);
  },
  onTerminalViewers: (cb: (e: TerminalViewersEvent) => void) => {
    const listener = (_: unknown, e: TerminalViewersEvent) => cb(e);
    bus.on(IpcEvents.terminalViewers, listener);
    return () => bus.removeListener(IpcEvents.terminalViewers, listener);
  },
  onChangesUpdated: (cb: (e: { sessionId: string }) => void) => {
    const listener = (_: unknown, e: { sessionId: string }) => cb(e);
    bus.on(IpcEvents.changesUpdated, listener);
    return () => bus.removeListener(IpcEvents.changesUpdated, listener);
  },
  onTasksUpdated: (cb) => {
    const listener = (_: unknown, tasks: import('@nekko-agent/shared').AutomationTask[]) => cb(tasks);
    bus.on(IpcEvents.tasksUpdated, listener);
    return () => bus.removeListener(IpcEvents.tasksUpdated, listener);
  },
  onBackgroundUpdated: (cb) => {
    const listener = (_: unknown, state: import('@nekko-agent/shared').BackgroundState) => cb(state);
    bus.on(IpcEvents.backgroundUpdated, listener);
    return () => bus.removeListener(IpcEvents.backgroundUpdated, listener);
  },
  onTrainingUpdated: (cb) => {
    const listener = (_: unknown, runs: import('@nekko-agent/shared').TrainingRun[]) => cb(runs);
    bus.on(IpcEvents.trainingUpdated, listener);
    return () => bus.removeListener(IpcEvents.trainingUpdated, listener);
  },
  onWorkflowsUpdated: (cb) => {
    const listener = (_: unknown, snapshot: import('@nekko-agent/shared').WorkflowsSnapshot) => cb(snapshot);
    bus.on(IpcEvents.workflowsUpdated, listener);
    return () => bus.removeListener(IpcEvents.workflowsUpdated, listener);
  },
  onRunnersChanged: (cb) => {
    const listener = (_: unknown, views: import('@nekko-agent/shared').RunnerView[]) => cb(views);
    bus.on(IpcEvents.runnerChanged, listener);
    return () => bus.removeListener(IpcEvents.runnerChanged, listener);
  },
  onDownloadsUpdated: (cb) => {
    const listener = (_: unknown, jobs: import('@nekko-agent/shared').DownloadJob[]) => cb(jobs);
    bus.on(IpcEvents.downloadsUpdated, listener);
    return () => bus.removeListener(IpcEvents.downloadsUpdated, listener);
  },
  onLimitsUpdated: (cb: (e: { tokenKey: string; limits: SubscriptionLimits }) => void) => {
    const listener = (_: unknown, e: { tokenKey: string; limits: SubscriptionLimits }) => cb(e);
    bus.on(IpcEvents.limitsUpdated, listener);
    return () => bus.removeListener(IpcEvents.limitsUpdated, listener);
  },
  onModelsUpdated: (cb: (e: { providerId: string }) => void) => {
    const listener = (_: unknown, e: { providerId: string }) => cb(e);
    bus.on(IpcEvents.modelsUpdated, listener);
    return () => bus.removeListener(IpcEvents.modelsUpdated, listener);
  },
  onSkillsUpdated: (cb: (catalog: import('@nekko-agent/shared').VaizerCatalog) => void) => {
    const listener = (_: unknown, catalog: import('@nekko-agent/shared').VaizerCatalog) => cb(catalog);
    bus.on(IpcEvents.skillsUpdated, listener);
    return () => bus.removeListener(IpcEvents.skillsUpdated, listener);
  },
  openTerminalStream: (id, handlers) => engine.openTerminal(id, handlers),
  onDeepLink: (cb: (url: string) => void) => {
    const listener = (_: unknown, url: string) => cb(url);
    bus.on(IpcEvents.deepLink, listener);
    return () => bus.removeListener(IpcEvents.deepLink, listener);
  },
};

contextBridge.exposeInMainWorld('nekko', api);

/**
 * The window-chrome bridge, separate from the app API on purpose: `NekkoApi`
 * is the contract the web transport also implements, and a browser tab has no
 * title bar to draw. Its absence is how the renderer knows it isn't in the
 * desktop shell.
 */
const chrome: WindowChromeBridge = {
  serviceControl: (action) => ipcRenderer.invoke(SERVICE_CONTROL_CHANNEL, action),
  reportNotificationVisibility: report => { if (process.isMainFrame) ipcRenderer.send(NOTIFICATION_VISIBILITY_CHANNEL, report); },
  platform: process.platform,
  titleBarHeight: TITLEBAR_HEIGHT,
  setTitleBarOverlay: (theme: TitleBarOverlayTheme) => ipcRenderer.send(TITLEBAR_OVERLAY_CHANNEL, theme),
  displays: {
    displayId: process.argv.find((a) => a.startsWith(DISPLAY_ARG))?.slice(DISPLAY_ARG.length) ?? null,
    list: () => ipcRenderer.invoke(DISPLAYS_LIST_CHANNEL),
    toggle: (id, on, reducedMotion) => ipcRenderer.invoke(DISPLAYS_TOGGLE_CHANNEL, id, on, reducedMotion),
    setPlacement: (placement) => ipcRenderer.invoke(DISPLAYS_PLACEMENT_CHANNEL, placement),
    toggleDesktop: (id, on) => ipcRenderer.invoke(DISPLAYS_DESKTOP_CHANNEL, id, on),
    setSpacesMode: (mode) => ipcRenderer.invoke(DISPLAYS_SPACES_MODE_CHANNEL, mode),
    go: (target) => ipcRenderer.invoke(DISPLAYS_GO_CHANNEL, target),
    report: (panes) => { if (process.isMainFrame) ipcRenderer.send(DISPLAYS_REPORT_CHANNEL, panes); },
    claim: (sessionId, mode) => ipcRenderer.invoke(DISPLAYS_CLAIM_CHANNEL, sessionId, mode),
    onChange: (cb) => {
      const listener = (_: unknown, state: DisplaysState) => cb(state);
      ipcRenderer.on(DISPLAYS_CHANGED_EVENT, listener);
      return () => { ipcRenderer.removeListener(DISPLAYS_CHANGED_EVENT, listener); };
    },
    onPlaced: (cb) => {
      const listener = (_: unknown, sessionId: string) => cb(sessionId);
      ipcRenderer.on(DISPLAYS_PLACED_EVENT, listener);
      return () => { ipcRenderer.removeListener(DISPLAYS_PLACED_EVENT, listener); };
    },
  },
};

contextBridge.exposeInMainWorld('nekkoChrome', chrome);
