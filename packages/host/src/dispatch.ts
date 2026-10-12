import { IpcChannels } from '@nekko-agent/shared';
import type { Host } from './host.js';
import { deleteAgentLog } from './agent-log.js';

/**
 * Maps an IPC channel + positional args to the matching Host method. Shared by
 * every transport (Electron IPC, the web server's HTTP routes) so request
 * routing lives in exactly one place. Returns the method's result.
 *
 * Note: `workspaceAdd` (the native folder picker) has no headless equivalent, so
 * transports that can't show a dialog (web) should call `workspaceAddByPath`
 * instead; here it degrades to listing current workspaces.
 */
export function createDispatcher(host: Host): (channel: string, args: any[]) => unknown {
  const C = IpcChannels;
  const table: Record<string, (a: any[]) => unknown> = {
    [C.settingsGet]: () => host.getSettings(),
    [C.settingsUpdate]: ([patch]) => host.updateSettings(patch),

    [C.providersList]: () => host.listProviders(),
    [C.providersSave]: ([p]) => host.saveProvider(p),
    [C.providersRemove]: ([id]) => host.removeProvider(id),
    [C.providersDiscover]: () => host.discoverProviders(),
    [C.providersProbe]: () => host.probeProviders(),
    [C.providersTest]: ([id]) => host.testProvider(id),
    [C.providersTestConfig]: ([cfg]) => host.testProviderConfig(cfg),

    [C.modelsList]: ([id]) => host.listModels(id),
    [C.modelPull]: ([id, m]) => host.pullModel(id, m),
    [C.modelLoad]: ([id, m]) => host.loadModel(id, m),
    [C.modelUnload]: ([id, m]) => host.unloadModel(id, m),
    [C.lmsProbe]: ([id]) => host.lmsAvailable(id),
    [C.serverStop]: ([id]) => host.stopServer(id),
    [C.runtimeStatus]: ([id]) => host.runtimeStatus(id),
    [C.runtimeStart]: ([id]) => host.runtimeStart(id),
    [C.runtimeStop]: ([id, force]) => host.runtimeStop(id, force),
    [C.runtimeLoad]: ([id, model, params]) => host.runtimeLoad(id, model, params),
    [C.runtimeFacts]: ([id]) => host.runtimeFacts(id),
    [C.runtimePlan]: ([id, model, req]) => host.runtimePlan(id, model, req),
    [C.runtimeAutoFit]: ([id, model, budget, slots]) => host.runtimeAutoFit(id, model, budget, slots),
    [C.voiceStatus]: () => host.voiceStatus(),
    [C.voiceInstall]: () => host.voiceInstall(),
    [C.voiceCancelInstall]: () => host.voiceCancelInstall(),
    [C.voiceUninstall]: () => host.voiceUninstall(),
    [C.voiceTranscribe]: ([wav]) => host.voiceTranscribe(wav),
    [C.engineStatus]: () => host.engineStatus(),
    // Internal: the engine daemon's router (crates/nekko-infer) asking the
    // engine's policy about a model it does not have running.
    'engine:routerLoad': ([id, image]) => host.engineRouterLoad(String(id), Boolean(image)),
    // Internal: the daemon's runtime control plane asking the engine (its `llamacpp` adapter).
    'engine:runtime': ([method, ...args]) => host.engineRuntime(String(method), args),
    // A daemon-driven agent run calling back (daemon-loop.ts).
    'loop:tool': ([runId, call]) => host.loopTool(String(runId), call as never),
    'loop:event': ([runId, payload]) => host.loopEvent(String(runId), payload as never),
    'loop:end': ([runId, payload]) => host.loopEnd(String(runId), payload as never),
    'loop:approve': ([runId, call, reason, severity]) => host.loopApprove(String(runId), call as never, String(reason), severity as never),
    'loop:log': ([sessionId, workspaceId, data]) => host.loopLog(String(sessionId), (workspaceId as string | null) ?? undefined, String(data)),
    // A daemon-driven chat turn calling back (daemon-turn.ts).
    'turn:event': (args) => host.turnCallback('turn:event', args),
    'turn:end': (args) => host.turnCallback('turn:end', args),
    'turn:tool': (args) => host.turnCallback('turn:tool', args),
    'turn:hook': (args) => host.turnCallback('turn:hook', args),
    'turn:headers': (args) => host.turnCallback('turn:headers', args),
    'turn:approved': (args) => host.turnCallback('turn:approved', args),
    'spawn:prepare': (args) => host.turnCallback('spawn:prepare', args),
    'turn:prepare': (args) => host.turnCallback('turn:prepare', args),
    'turn:usage': (args) => host.turnCallback('turn:usage', args),
    'turn:notify': (args) => host.turnCallback('turn:notify', args),
    // The daemon merges its own pending input with this process's.
    'chat:pending:host': () => host.hostPendingInput(),
    // Internal daemon callback, using the host queue and deletion tombstone.
    'sessions:deleteAgentLog': ([id]) => deleteAgentLog(String(id)),
    'changes:notify': ([sessionId]) => host.changesNotify(String(sessionId)),
    // The daemon writes settings.json (crates/nekkod/src/settings.rs) and tells this host what changed.
    'settings:changed': ([next, patch]) => host.settingsChanged(next as never, (patch ?? null) as never),
    // The daemon keeps limit state (crates/nekkod/src/limits.rs) and asks this
    // host only for what still lives here: a refreshed sign-in, and the relay.
    'limits:notify': ([payload]) => host.limitsNotify(payload as never),
    'oauth:refresh': ([tokenKey]) => host.oauthRefresh(String(tokenKey)),
    // The daemon resolved a Hypergate gateway (crates/nekkod/src/hypergate.rs); the entry is a setting.
    'mcp:hypergate:save': ([info]) => host.hypergateSave(info as never),
    'engine:routerModels': () => host.engineRouterModels(),
    'engine:routerModel': ([id]) => host.engineRouterModel(String(id)),
    [C.engineInstall]: ([buildId, runtime]) => host.engineInstall(buildId, runtime),
    [C.engineUninstall]: ([runtime]) => host.engineUninstall(runtime),
    [C.engineInstallPreview]: ([runtime, buildId]) => host.engineInstallPreview(runtime, buildId),
    [C.engineGenerateImage]: ([request]) => host.engineGenerateImage(request),
    [C.engineSettingsSave]: ([patch]) => host.engineSettingsSave(patch),
    [C.engineModels]: () => host.engineModels(),
    [C.engineImportModel]: ([path]) => host.engineImportModel(path),
    [C.engineDeleteModel]: ([id]) => host.engineDeleteModel(id),
    [C.engineSaveModelPreset]: ([id, preset]) => host.engineSaveModelPreset(id, preset),
    [C.engineCatalog]: ([query, format]) => host.engineCatalog(query, format),
    [C.engineCatalogModel]: ([id]) => host.engineCatalogModel(id),
    [C.engineCatalogDetail]: ([id]) => host.engineCatalogDetail(id),
    [C.engineFolders]: () => host.engineFolders(),
    [C.engineFoldersSave]: ([folders]) => host.engineFoldersSave(folders),
    [C.engineDownloadModel]: ([id, quant]) => host.engineDownloadModel(id, quant),
    [C.engineDownloadCompanions]: ([id]) => host.engineDownloadCompanions(id),
    [C.engineImageCompanions]: ([id]) => host.engineImageCompanions(id),
    [C.engineDownloadImageCompanions]: ([id]) => host.engineDownloadImageCompanions(id),
    [C.decisionsCatalog]: () => host.decisionsCatalog(),
    [C.decisionsModels]: () => host.decisionsModels(),
    [C.decisionsDownload]: ([catalogId, precision]) => host.decisionsDownload(catalogId, precision),
    [C.decisionsDelete]: ([id]) => host.decisionsDelete(id),
    [C.decisionsAddFolder]: ([path]) => host.decisionsAddFolder(path),
    [C.decisionsStatus]: () => host.decisionsStatus(),
    [C.decisionsLoad]: ([id, precision]) => host.decisionsLoad(id, precision),
    [C.decisionsUnload]: () => host.decisionsUnload(),
    [C.decisionsRun]: ([provider, request]) => host.decisionsRun(provider, request),
    [C.decisionsCheckTypesafe]: () => host.decisionsCheckTypesafe(),
    [C.engineSetResidentTtl]: ([id, ttl]) => host.engineSetResidentTtl(id, ttl),
    [C.engineSetAutoload]: ([id, enabled]) => host.engineSetAutoload(id, enabled),
    [C.engineDownloads]: () => host.engineDownloads(),
    [C.engineCancelDownload]: ([id]) => host.engineCancelDownload(id),
    [C.engineDismissDownload]: ([id]) => host.engineDismissDownload(id),
    [C.machineReadiness]: ([language]) => host.machineReadiness(language),
    [C.gpuStats]: () => host.getGpuStats(),
    [C.systemStats]: () => host.getSystemStats(),

    [C.sessionsList]: () => host.listSessions(),
    [C.sessionNextWatch]: ([id]) => host.nextAgentWatchAt(id),
    [C.sessionsSummaries]: () => host.listSessionSummaries(),
    [C.sandboxConfigure]: ([id, image]) => host.configureSandbox(id, image),
    [C.sandboxCleanup]: ([id, identity]) => host.cleanupSandbox(id, identity),
    [C.sandboxStatus]: ([id]) => host.sandboxStatus(id),
    [C.sandboxDiff]: ([id]) => host.sandboxDiff(id),
    [C.sandboxApplyDiff]: ([id, identity, diffId, paths]) => host.applySandboxDiff(id, identity, diffId, paths),
    [C.sessionCreate]: ([wid]) => host.createSession(wid),
    [C.sessionGet]: ([id]) => host.getSession(id),
    [C.sessionDelete]: ([id]) => host.deleteSession(id),
    [C.sessionSetWorkspace]: ([id, wid]) => host.setSessionWorkspace(id, wid),
    [C.sessionSetSupportingWorkspaces]: ([id, wids]) => host.setSessionSupportingWorkspaces(id, wids),
    [C.chatSend]: ([opts]) => host.sendChat(opts),
    [C.chatGenerateImage]: ([opts]) => host.generateImageTurn(opts),
    [C.sessionImages]: ([id, limit]) => host.sessionImages(id, limit),
    [C.chatAbort]: ([id]) => host.abortChat(id),
    [C.chatCompact]: ([id, opts]) => host.compactSession(id, opts),
    [C.chatCancelCompaction]: ([id]) => host.cancelSessionCompaction(id),
    [C.chatQueue]: ([id, text]) => host.queuePrompt(id, text),
    [C.chatDequeue]: ([id, idx]) => host.dequeuePrompt(id, idx),
    [C.chatSteer]: ([id, text]) => host.steerChat(id, text),
    [C.chatInterruptQueued]: ([id, idx, brain]) => host.interruptQueuedPrompt(id, idx, brain),
    [C.resourceQueue]: ([action, input]) => host.resourceQueue(action, input),
    [C.chatSuggest]: ([sid]) => host.suggestReplies(sid),
    [C.chatFillPrompt]: ([sid, part, draft]) => host.fillPromptPart(sid, part, draft),
    [C.toolApprove]: ([sid, tid, ok]) => host.approveTool(sid, tid, ok),
    [C.chatAnswer]: ([sid, callId, answers]) => host.answerQuestion(sid, callId, answers),
    [C.chatPending]: () => host.pendingInput(),
    [C.chatRunning]: () => host.runningSessions(),

    [C.terminalsList]: () => host.listTerminals(),
    [C.terminalShells]: () => host.listShells(),
    [C.terminalCreate]: ([opts]) => host.createTerminal(opts),
    [C.terminalSnapshot]: ([id]) => host.terminalSnapshot(id),
    [C.terminalUpdate]: ([id, patch]) => host.updateTerminal(id, patch),
    [C.terminalWrite]: ([id, data]) => host.writeTerminal(id, data),
    [C.terminalResize]: ([id, cols, rows]) => host.resizeTerminal(id, cols, rows),
    [C.terminalRun]: ([id, cmd]) => host.runInTerminal(id, cmd),
    [C.terminalSignal]: ([id, sig]) => host.signalTerminal(id, sig),
    [C.terminalClose]: ([id]) => host.closeTerminal(id),

    [C.contextPreview]: ([sid, paths]) => host.previewContext(sid, paths),
    [C.contextToggle]: ([sid]) => host.previewContext(sid, []),
    [C.contextSetPrefs]: ([sid, prefs]) => host.setContextPrefs(sid, prefs),
    [C.sessionSetAttachments]: ([sid, paths]) => host.setSessionAttachments(sid, paths),
    [C.specBuild]: ([sid]) => host.buildSpec(sid),
    [C.specBuildDoc]: ([sid, docId, wid]) => host.buildSpecDoc(sid, docId, wid),
    [C.specReadDocs]: ([sid, wid]) => host.readSpecDocs(sid, wid),
    [C.specSetMethodology]: ([sid, mid]) => host.setSpecMethodology(sid, mid),
    [C.specToggleTask]: ([sid, line, wid]) => host.toggleSpecTask(sid, line, wid),
    [C.specSetLinked]: ([sid, linked]) => host.setSpecLinked(sid, linked),
    [C.specPath]: ([sid]) => host.specPath(sid),
    [C.sessionSetOptions]: ([sid, patch]) => host.setSessionOptions(sid, patch),
    [C.sessionTruncate]: ([sid, mid]) => host.truncateSession(sid, mid),
    [C.sessionsClear]: ([scope]) => host.clearSessions(scope),
    [C.sessionsPurgeArchived]: () => host.purgeExpiredArchives(),
    [C.sessionFork]: ([id, before]) => host.forkSession(id, before),
    [C.settingsReset]: () => host.resetSettings(),
    [C.dataWipe]: () => host.wipeAllData(),
    [C.toolsList]: () => host.listTools(),

    [C.memoryList]: ([scope, wid]) => host.listMemory(scope, wid),
    [C.memorySave]: ([entry]) => host.saveMemory(entry),
    [C.memoryDelete]: ([id]) => host.deleteMemory(id),

    [C.workspaceList]: () => host.listWorkspaces(),
    [C.workspaceAdd]: () => host.listWorkspaces(), // no headless folder picker
    [C.workspaceAddByPath]: ([p]) => host.addWorkspaceByPath(p),
    [C.workspaceRemove]: ([id]) => host.removeWorkspace(id),
    [C.workspaceIndex]: ([id]) => host.indexWorkspace(id),
    [C.workspaceIndexStatus]: ([id]) => host.getIndexStatus(id),
    [C.workspaceSearch]: ([id, q]) => host.searchWorkspace(id, q),
    [C.workspaceFiles]: ([id]) => host.listFiles(id),
    [C.workspaceGitStatus]: ([id, force]) => host.getGitStatus(id, force),
    [C.chatWorktreesList]: () => host.listChatWorktrees(),
    [C.chatWorktreesRemove]: ([root]) => host.removeChatWorktree(root),

    [C.fileRead]: ([p]) => host.readFile(p),
    [C.fileWrite]: ([p, content]) => host.writeFile(p, content),
    [C.dirList]: ([p]) => host.listDir(p),

    [C.changesList]: ([sid]) => host.listChanges(sid),
    [C.changeAccept]: ([sid, p]) => host.acceptChange(sid, p),
    [C.changeAcceptAll]: ([sid]) => host.acceptAllChanges(sid),

    [C.prSessionList]: ([sid]) => host.listSessionPrs(sid),
    [C.prDiff]: ([url]) => host.getPrDiff(url),
    [C.prAction]: ([url, action]) => host.prAction(url, action),

    [C.commentsList]: ([p]) => host.listComments(p),
    [C.commentAdd]: ([p, line, lineText, comment]) => host.addComment(p, line, lineText, comment),
    [C.commentResolve]: ([p, id]) => host.resolveComment(p, id),

    [C.designGet]: ([wid]) => host.getDesignBoard(wid),
    [C.designAddPage]: ([wid, label, url]) => host.addDesignPage(wid, label, url),
    [C.designUpdatePage]: ([wid, pid, patch]) => host.updateDesignPage(wid, pid, patch),
    [C.designRemovePage]: ([wid, pid]) => host.removeDesignPage(wid, pid),
    [C.designAddNote]: ([wid, pid, text]) => host.addDesignNote(wid, pid, text),
    [C.designResolveNote]: ([wid, pid, nid]) => host.resolveDesignNote(wid, pid, nid),
    [C.designGenerate]: ([wid, input]) => host.generateDesign(wid, input),

    [C.skillsInstalled]: () => host.listInstalledSkills(),
    [C.skillsExternal]: ()=> host.listExternalSkills(),
    [C.skillsTargets]: () => host.skillTargets(),
    [C.skillInstall]: ([id, target, payload]) => host.installSkill(id, target, payload),
    [C.skillUninstall]: ([id, target]) => host.uninstallSkill(id, target),
    [C.vaizerCatalog]: ([refresh]) => host.vaizerCatalog(refresh),
    [C.vaizerSkillMd]: ([slug]) => host.vaizerSkillMd(slug),

    [C.tasksList]: () => host.listTasks(),
    [C.taskCreate]: ([task]) => host.createTask(task),
    [C.taskUpdate]: ([id, patch]) => host.updateTask(id, patch),
    [C.taskDelete]: ([id]) => host.deleteTask(id),
    [C.taskRunNow]: ([id]) => host.runTaskNow(id),

    [C.trainingList]: () => host.listTrainingRuns(),
    [C.trainingCreate]: ([input]) => host.createTrainingRun(input),
    [C.trainingUpdate]: ([id, patch]) => host.updateTrainingRun(id, patch),
    [C.trainingDelete]: ([id]) => host.deleteTrainingRun(id),
    [C.trainingStart]: ([id]) => host.startTrainingRun(id),
    [C.trainingPause]: ([id]) => host.pauseTrainingRun(id),
    [C.trainingStop]: ([id]) => host.stopTrainingRun(id),
    [C.trainingHint]: ([id, text]) => host.addTrainingHint(id, text),

    [C.workflowsList]: () => host.listWorkflows(),
    [C.workflowCreate]: ([input]) => host.createWorkflow(input),
    [C.workflowUpdate]: ([id, patch]) => host.updateWorkflow(id, patch),
    [C.workflowDelete]: ([id]) => host.deleteWorkflow(id),
    [C.workflowDuplicate]: ([id]) => host.duplicateWorkflow(id),
    [C.workflowRun]: ([id]) => host.runWorkflow(id),
    [C.workflowCancel]: ([runId]) => host.cancelWorkflowRun(runId),
    [C.workflowRuns]: ([wid]) => host.listWorkflowRuns(wid),
    [C.workflowEvent]: ([event]) => host.dispatchWorkflowEvent(event),

    [C.connectorsList]: () => host.listConnectors(),
    [C.connectorConnect]: ([kind, token, settings]) => host.connectConnector(kind, token, settings),
    [C.connectorDisconnect]: ([kind]) => host.disconnectConnector(kind),
    [C.connectorFetch]: ([kind, query]) => host.fetchConnector(kind, query),

    [C.integrationsDetect]: () => host.detectAgentTools(),
    [C.integrationsInstall]: ([tool, target]) => host.installSubagent(tool, target),
    [C.integrationsSnippet]: ([tool, target]) => host.subagentSnippet(tool, target),

    [C.guardrailsClassify]: ([cmd]) => host.classifyCommand(cmd),
    [C.usageSummary]: () => host.usageSummary(),
    [C.limitsGet]: ([tokenKey, refresh]) => host.getLimits(tokenKey, refresh),
    [C.limitsProblem]: ([tokenKey]) => host.getLimitsProblem(tokenKey),

    [C.oauthBegin]: ([provider]) => host.beginOAuth(provider),
    [C.oauthFinish]: ([sessionId, pasted]) => host.finishOAuth(sessionId, pasted),
    [C.oauthCancel]: ([sessionId]) => host.cancelOAuth(sessionId),
    [C.oauthStatus]: ([providerConfigId]) => host.oauthStatus(providerConfigId),
    [C.oauthSignOut]: ([providerConfigId]) => host.oauthSignOut(providerConfigId),
    [C.providersImportCliAuth]: () => host.importCliAuth(),

    [C.remoteEnable]: ([relayUrl]) => host.enableRemote(relayUrl),
    [C.remoteDisable]: () => host.disableRemote(),
    [C.remoteStatus]: () => host.remoteStatus(),
    [C.messagingStatus]: () => host.messagingStatus(),
    [C.remotePairing]: () => host.remotePairing(),
    [C.remotePair]: () => host.startRemotePairing(),
    [C.remoteDevices]: () => host.listRemoteDevices(),
    [C.remoteRevoke]: ([deviceId]) => host.revokeRemoteDevice(deviceId),
    [C.remoteRename]: ([deviceId, name]) => host.renameRemoteDevice(deviceId, name),
    [C.remoteRotate]: () => host.rotateRemoteSecret(),

    [C.appInfo]: () => host.appInfo(),
    [C.updatesCheck]: () => host.runUpdateChecks(),
    [C.mcpStatus]: () => host.mcpStatus(),
    [C.mcpHypergate]: ([port]) => host.detectHypergate(port),
    [C.mcpHypergateConnect]: ([port]) => host.connectHypergate(port),
  };

  // A Map: a channel named constructor or __proto__ is unknown, never Object.prototype's.
  const handlers = new Map(Object.entries(table));
  return (channel, args) => {
    const fn = handlers.get(channel);
    if (typeof fn !== 'function') throw new Error(`Unknown channel: ${channel}`);
    return fn(args ?? []);
  };
}
