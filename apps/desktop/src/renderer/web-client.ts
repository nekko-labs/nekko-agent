import { AGENT_REPLAY, IpcChannels, IpcEvents, deriveKey, seal, open, withApiServerDefaults, RELEASE_NOTES_URL, LOCAL_RELAY_PORT } from '@nekko-agent/shared';
import type { AgentReplay, LocalRelayStatus, NetworkVisibilityStatus, AppSettings, AgentEvent, IndexStatus, NekkoApi, AppInfo, ClaudeCapabilityStatus, ClaudeCodeStatus, ClaudePlanUsageStatus, ClaudePolicyStatus, UpdateInfo, TerminalEvent, OAuthStatus, SubscriptionLimits } from '@nekko-agent/shared';
import { readBrandKey } from './brandStorage.js';
import { openTerminalSocket } from './terminal-socket.js';

/**
 * Browser transport for the web/Docker editions: implements the same NekkoApi
 * the Electron preload exposes, but over HTTP (`POST /api/:channel`) and a
 * WebSocket (`/api/events`). Installed only when no Electron preload bridge is
 * present, so the React UI is byte-for-byte identical across runtimes.
 */
/**
 * The local API server, as this edition has to answer for it: it already is one,
 * and it is the one serving this page. `available: false` is what stops the
 * Models tab offering a start button with nothing behind it.
 */
/** No "relay on this computer" in a browser tab; the Remote access card hides it on `available === false`. */
const webLocalRelay: LocalRelayStatus = { running: false, enabled: false, port: LOCAL_RELAY_PORT, available: false };
const webVisibility: NetworkVisibilityStatus = { enabled: false, advertising: false, available: false };

function webApiServerStatus() {
  return {
    settings: withApiServerDefaults(undefined),
    running: true,
    available: false,
    url: location.origin,
    clientUrl: location.origin,
    clients: 0,
    requests: 0,
  };
}

/** A server-side folder path typed by the user; null when cancelled or empty. */
function promptFolder(): string | null {
  return window.prompt('Folder path on the server to add as a workspace:')?.trim() || null;
}

function makeWebClient(): NekkoApi {
  // Token (only needed when the server is exposed beyond localhost). Accept it
  // from the URL once, then remember it for the session.
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) sessionStorage.setItem('nekko_token', urlToken);
  const token = () => readBrandKey(sessionStorage, 'nekko_token') ?? '';

  const agentCbs = new Set<(e: AgentEvent) => void>();
  const indexCbs = new Set<(s: IndexStatus) => void>();
  const terminalCbs = new Set<(e: TerminalEvent) => void>();
  const changesCbs = new Set<(e: { sessionId: string }) => void>();
  const tasksCbs = new Set<(t: import('@nekko-agent/shared').AutomationTask[]) => void>();
  const trainingCbs = new Set<(r: import('@nekko-agent/shared').TrainingRun[]) => void>();
  const workflowCbs = new Set<(s: import('@nekko-agent/shared').WorkflowsSnapshot) => void>();
  const oauthStatusCbs = new Set<(s: OAuthStatus) => void>();
  const limitsUpdatedCbs = new Set<(e: { tokenKey: string; limits: SubscriptionLimits }) => void>();
  const downloadsUpdatedCbs = new Set<(jobs: import('@nekko-agent/shared').DownloadJob[]) => void>();
  const modelsUpdatedCbs = new Set<(e: { providerId: string }) => void>();
  const skillsUpdatedCbs = new Set<(catalog: import('@nekko-agent/shared').VaizerCatalog) => void>();
  const replayCbs = new Set<(r: AgentReplay) => void>();
  // Narrowing the agent event stream: only over the server's own socket to nekkod.
  let subscribe: (ids: string[] | null) => void = () => {};
  // Server build version captured when this tab loaded (for refresh detection).
  let loadVersion: string | null = null;
  const dispatchEvent = (channel: string, payload: any) => {
    if (channel === IpcEvents.agentEvent) agentCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.indexProgress) indexCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.terminalEvent) terminalCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.changesUpdated) changesCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.tasksUpdated) tasksCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.trainingUpdated) trainingCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.workflowsUpdated) workflowCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.oauthStatus) oauthStatusCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.limitsUpdated) limitsUpdatedCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.downloadsUpdated) downloadsUpdatedCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.modelsUpdated) modelsUpdatedCbs.forEach((cb) => cb(payload));
    else if (channel === IpcEvents.skillsUpdated) skillsUpdatedCbs.forEach((cb) => cb(payload));
  };

  // Relay transport: when the page is opened with ?relay=&room=&key=[&pair=],
  // talk to a paired local agent through the relay instead of a same-origin
  // server. This is how a phone drives your local model. The native mobile app
  // has no URL query, so we also accept creds saved in localStorage by the
  // pairing screen. Every connection must complete the E2E HELLO handshake
  // (device identity + optional one-time pairing code) before the agent serves
  // it; revoked/unknown devices are denied and sent back to pairing.
  const p = new URLSearchParams(location.search);
  let relayUrl = p.get('relay');
  let room = p.get('room');
  let key = p.get('key');
  let pairCode: string | null = p.get('pair');
  if (relayUrl && room && key) {
    // Persist creds and scrub them from the address bar/history right away.
    localStorage.setItem('nekko_relay', JSON.stringify({ relay: relayUrl, room, key }));
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* ignore */
    }
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem('nekko_relay') || 'null');
      if (saved?.relay && saved?.room && saved?.key) {
        relayUrl = saved.relay;
        room = saved.room;
        key = saved.key;
        // Native pairing screen stores the one-time code alongside the creds
        // (there's no URL to carry it after the reload).
        if (saved.pair) pairCode = saved.pair;
      }
    } catch {
      /* ignore */
    }
  }
  let call: (channel: string, ...args: unknown[]) => Promise<any>;
  // Send the phone's push token to the relay (relay transport only).
  let registerPush: (token: string, platform: string) => Promise<void> = async () => {};
  // A terminal's own binary socket, when the server runs behind nekkod; null
  // sends the pane down the event-bus path (the relay, the in-process host).
  let openTerminalStream: NonNullable<NekkoApi['openTerminalStream']> = async () => null;

  if (relayUrl && room && key) {
    // Stable device identity for the agent's paired-device registry.
    let deviceId = localStorage.getItem('nekko_device_id');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('nekko_device_id', deviceId);
    }
    const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const platform = cap?.getPlatform?.() ?? 'web';
    const ua = navigator.userAgent;
    const deviceName = /iPhone/.test(ua)
      ? 'iPhone'
      : /iPad/.test(ua)
        ? 'iPad'
        : /Android/.test(ua)
          ? 'Android phone'
          : /Mac/.test(ua)
            ? 'Mac browser'
            : /Windows/.test(ua)
              ? 'Windows browser'
              : 'Browser';

    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    let nextId = 1;
    let relay: WebSocket | null = null;
    let welcomed = false;
    // E2E key shared with the agent; the relay only carries ciphertext.
    const keyP = deriveKey(key, room);
    const sendSealed = async (frame: unknown) => {
      relay?.send(JSON.stringify({ enc: await seal(await keyP, frame) }));
    };
    const onDenied = (reason: string) => {
      // Kicked out of the registry (revoked, or a stale/used pairing link).
      localStorage.removeItem('nekko_relay');
      sessionStorage.setItem('nekko_relay_denied', reason);
      if (cap) location.reload(); // native shell → back to the pairing screen
      else alert(`This device can't reach the paired computer (${reason}). Pair it again from Settings → Remote access.`);
    };
    const handle = async (frame: any) => {
      if (frame.type === 'welcome') {
        welcomed = true;
        pairCode = null; // enrollment done; never resend the code
        sessionStorage.removeItem('nekko_relay_denied');
        // Drop a stored one-time code so it never leaks or gets replayed.
        localStorage.setItem('nekko_relay', JSON.stringify({ relay: relayUrl, room, key }));
      } else if (frame.type === 'denied') {
        onDenied(String(frame.reason || 'denied'));
      } else if (frame.type === 'res' && pending.has(frame.id)) {
        const { resolve, reject } = pending.get(frame.id)!;
        pending.delete(frame.id);
        frame.error ? reject(new Error(frame.error)) : resolve(frame.result);
      } else if (frame.type === 'event') {
        dispatchEvent(frame.channel, frame.payload);
      }
    };
    const connect = () => {
      welcomed = false;
      relay = new WebSocket(`${relayUrl.replace(/\/$/, '')}/relay?role=client&room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}`);
      relay.onopen = () => {
        void sendSealed({ type: 'hello', deviceId, name: deviceName, platform, ...(pairCode ? { pair: pairCode } : {}) });
      };
      relay.onmessage = async (ev) => {
        let env: any;
        try {
          env = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (env.enc) {
          try {
            handle(await open(await keyP, env.enc));
          } catch {
            /* tampered / wrong key */
          }
        } else if (env.type === 'agent-online' && relay?.readyState === WebSocket.OPEN && !welcomed) {
          // Agent (re)connected after us → repeat the handshake.
          void sendSealed({ type: 'hello', deviceId, name: deviceName, platform, ...(pairCode ? { pair: pairCode } : {}) });
        }
      };
      relay.onclose = (ev) => {
        welcomed = false;
        if (ev.code === 4001) return; // kicked (revoked) → don't reconnect-loop
        setTimeout(connect, 1000);
      };
    };
    connect();
    const ready = () =>
      new Promise<void>((res, rej) => {
        if (welcomed) return res();
        const t = setInterval(() => {
          if (welcomed) {
            clearInterval(t);
            res();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(t);
          rej(new Error('relay not connected'));
        }, 10000);
      });
    call = async (channel, ...args) => {
      await ready();
      const id = nextId++;
      const enc = await seal(await keyP, { type: 'req', id, channel, args });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        relay!.send(JSON.stringify({ enc }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${channel}: timed out`));
          }
        }, 120000);
      });
    };
    registerPush = async (token, platform2) => {
      await ready();
      relay!.send(JSON.stringify({ type: 'register-push', token, platform: platform2, deviceId }));
    };
  } else {
    // HTTP transport (same-origin web server).
    call = async (channel, ...args) => {
      const res = await fetch(`/api/${channel}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        },
        body: JSON.stringify({ args }),
      });
      if (!res.ok) {
        // The server sends the host's own error message; show that, not just the status.
        const detail = await res.json().then((b: { error?: unknown }) => (typeof b?.error === 'string' ? b.error : ''), () => '');
        throw new Error(detail || `${channel}: HTTP ${res.status}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    };
    let ws: WebSocket | null = null;
    // Asked once: an older server (or one running the engine in-process) has no such channel.
    let caps: Promise<{ terminalStream?: boolean; engine?: string } | null> | null = null;
    const capabilities = () => (caps ??= call('web:capabilities').catch(() => null));
    // The chats whose agent event stream this page takes (null: every chat's).
    // Only nekkod narrows a stream; the in-process server sends everything.
    let narrowTo: string[] | null = null;
    let daemonEvents = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams();
      if (daemonEvents && narrowTo) params.set('sessions', narrowTo.join(','));
      if (token()) params.set('token', token());
      const q = params.toString() ? `?${params}` : '';
      const socket = new WebSocket(`${proto}://${location.host}/api/events${q}`);
      ws = socket;
      socket.onmessage = (ev) => {
        try {
          const { channel, payload } = JSON.parse(ev.data);
          if (channel === AGENT_REPLAY) replayCbs.forEach((cb) => cb(payload));
          else dispatchEvent(channel, payload);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => setTimeout(connect, 1000); // auto-reconnect
    };
    connect();
    void capabilities().then((c) => { daemonEvents = c?.engine === 'nekkod'; if (daemonEvents) subscribe(narrowTo); });
    subscribe = (ids) => {
      narrowTo = ids ? [...new Set(ids)] : null;
      if (!daemonEvents || ws?.readyState !== WebSocket.OPEN) return; // sent with the next connect
      ws.send(JSON.stringify({ channel: 'daemon:subscribe', args: [narrowTo] }));
    };
    const daemonTerminals = () => capabilities().then((c) => c?.terminalStream === true);
    openTerminalStream = async (id, handlers) => {
      if (!(await daemonTerminals())) return null;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = token() ? `?token=${encodeURIComponent(token())}` : '';
      return openTerminalSocket(`${proto}://${location.host}/api/term/${encodeURIComponent(id)}${q}`, handlers);
    };
  }

  return {
    getSettings: () => call(IpcChannels.settingsGet),
    updateSettings: (patch) => call(IpcChannels.settingsUpdate, patch),

    listProviders: () => call(IpcChannels.providersList),
    saveProvider: (p) => call(IpcChannels.providersSave, p),
    removeProvider: (id) => call(IpcChannels.providersRemove, id),
    discoverProviders: () => call(IpcChannels.providersDiscover),
    probeProviders: () => call(IpcChannels.providersProbe),
    testProvider: (id) => call(IpcChannels.providersTest, id),
    testProviderConfig: (cfg) => call(IpcChannels.providersTestConfig, cfg),

    listModels: (providerId) => call(IpcChannels.modelsList, providerId),
    listModelsStatus: (providerId) => call(IpcChannels.modelsListStatus, providerId),
    pullModel: (providerId, model) => call(IpcChannels.modelPull, providerId, model),
    loadModel: (providerId, model) => call(IpcChannels.modelLoad, providerId, model),
    unloadModel: (providerId, model) => call(IpcChannels.modelUnload, providerId, model),
    lmsAvailable: (providerId) => call(IpcChannels.lmsProbe, providerId),
    stopServer: (providerId) => call(IpcChannels.serverStop, providerId),
    runtimeStatus: (providerId) => call(IpcChannels.runtimeStatus, providerId),
    runtimeStart: (providerId) => call(IpcChannels.runtimeStart, providerId),
    runtimeStop: (providerId, force) => call(IpcChannels.runtimeStop, providerId, force),
    runtimeLoad: (providerId, modelId, params) => call(IpcChannels.runtimeLoad, providerId, modelId, params),
    runtimeFacts: (providerId) => call(IpcChannels.runtimeFacts, providerId),
    runtimePlan: (providerId, modelId, req) => call(IpcChannels.runtimePlan, providerId, modelId, req),
    runtimeAutoFit: (providerId, modelId, budgetFraction, parallelSlots) =>
      call(IpcChannels.runtimeAutoFit, providerId, modelId, budgetFraction, parallelSlots),
    voiceStatus: () => call(IpcChannels.voiceStatus),
  voiceInstall: () => call(IpcChannels.voiceInstall),
  voiceCancelInstall: () => call(IpcChannels.voiceCancelInstall),
  voiceUninstall: () => call(IpcChannels.voiceUninstall),
  voiceTranscribe: (wav) => call(IpcChannels.voiceTranscribe, wav),
  voicePermission: async () => ({ status: 'Use browser microphone permissions', platform: 'web' }),
  engineStatus: () => call(IpcChannels.engineStatus),
    engineInstall: (buildId, runtime) => call(IpcChannels.engineInstall, buildId, runtime),
    engineUninstall: (runtime) => call(IpcChannels.engineUninstall, runtime),
    engineInstallPreview: (runtime, buildId) => call(IpcChannels.engineInstallPreview, runtime, buildId),
    engineGenerateImage: (request) => call(IpcChannels.engineGenerateImage, request),
    engineSettingsSave: (patch) => call(IpcChannels.engineSettingsSave, patch),
    engineModels: () => call(IpcChannels.engineModels),
    engineImportModel: (path) => call(IpcChannels.engineImportModel, path),
    engineDeleteModel: (id) => call(IpcChannels.engineDeleteModel, id),
    engineSaveModelPreset: (id, preset) => call(IpcChannels.engineSaveModelPreset, id, preset),
    engineCatalog: (query, format) => call(IpcChannels.engineCatalog, query, format),
    engineCatalogModel: (id) => call(IpcChannels.engineCatalogModel, id),
    engineCatalogDetail: (id) => call(IpcChannels.engineCatalogDetail, id),
    engineFolders: () => call(IpcChannels.engineFolders),
    engineFoldersSave: (folders) => call(IpcChannels.engineFoldersSave, folders),
    engineDownloadModel: (modelId, quantLabel) => call(IpcChannels.engineDownloadModel, modelId, quantLabel),
    engineDownloadCompanions: (modelId) => call(IpcChannels.engineDownloadCompanions, modelId),
    engineImageCompanions: (modelId) => call(IpcChannels.engineImageCompanions, modelId),
    engineDownloadImageCompanions: (modelId) => call(IpcChannels.engineDownloadImageCompanions, modelId),
    decisionsCatalog: () => call(IpcChannels.decisionsCatalog),
    decisionsModels: () => call(IpcChannels.decisionsModels),
    decisionsDownload: (catalogId, precision) => call(IpcChannels.decisionsDownload, catalogId, precision),
    decisionsDelete: (id) => call(IpcChannels.decisionsDelete, id),
    decisionsAddFolder: (path) => call(IpcChannels.decisionsAddFolder, path),
    decisionsStatus: () => call(IpcChannels.decisionsStatus),
    decisionsLoad: (id, precision) => call(IpcChannels.decisionsLoad, id, precision),
    decisionsUnload: () => call(IpcChannels.decisionsUnload),
    decisionsRun: (provider, request) => call(IpcChannels.decisionsRun, provider, request),
    decisionsCheckTypesafe: () => call(IpcChannels.decisionsCheckTypesafe),
    engineSetResidentTtl: (modelId, ttlSeconds) => call(IpcChannels.engineSetResidentTtl, modelId, ttlSeconds),
    engineSetAutoload: (modelId, enabled) => call(IpcChannels.engineSetAutoload, modelId, enabled),
    engineDownloads: () => call(IpcChannels.engineDownloads),
    engineCancelDownload: (id) => call(IpcChannels.engineCancelDownload, id),
    engineDismissDownload: (id) => call(IpcChannels.engineDismissDownload, id),
    // This edition already is the server, so there is nothing to switch on: the
    // Models tab reads `running: false` here and says so instead of offering a
    // toggle that could not do anything.
    apiServerStatus: async () => webApiServerStatus(),
    apiServerSave: async () => webApiServerStatus(),
    apiServerNewToken: async () => webApiServerStatus(),
    // No binary ships with this edition to link; the CLI is an npm install here.
    cliInstallStatus: async () => ({ available: false, installed: false, onPath: false, command: 'npx nekko-agent' }),
    cliInstall: async () => ({ available: false, installed: false, onPath: false, command: 'npx nekko-agent' }),
    machineReadiness: (language) => call(IpcChannels.machineReadiness, language),
    getGpuStats: () => call(IpcChannels.gpuStats),
    getSystemStats: () => call(IpcChannels.systemStats),

    listSessions: () => call(IpcChannels.sessionsList),
    nextAgentWatchAt: (sessionId) => call(IpcChannels.sessionNextWatch, sessionId),
    listAgentWatches: (sessionId) => call(IpcChannels.sessionWatches, sessionId),
    listSessionSummaries: () => call(IpcChannels.sessionsSummaries),
    createSession: (workspaceId) => call(IpcChannels.sessionCreate, workspaceId),
    getSession: (id) => call(IpcChannels.sessionGet, id),
    deleteSession: (id) => call(IpcChannels.sessionDelete, id),
    setSessionWorkspace: (sessionId, workspaceId) => call(IpcChannels.sessionSetWorkspace, sessionId, workspaceId),
    setSessionSupportingWorkspaces: (sessionId, workspaceIds) =>
      call(IpcChannels.sessionSetSupportingWorkspaces, sessionId, workspaceIds),
    setSessionAttachments: (sessionId, paths) => call(IpcChannels.sessionSetAttachments, sessionId, paths),
    sendChat: (opts) => call(IpcChannels.chatSend, opts),
    generateImageTurn: (opts) => call(IpcChannels.chatGenerateImage, opts),
    sessionImages: (sessionId, limit) => call(IpcChannels.sessionImages, sessionId, limit),
    abortChat: (sessionId) => call(IpcChannels.chatAbort, sessionId),
    compactSession: (sessionId, opts) => call(IpcChannels.chatCompact, sessionId, opts),
    cancelSessionCompaction: (sessionId) => call(IpcChannels.chatCancelCompaction, sessionId),
    queuePrompt: (sessionId, text) => call(IpcChannels.chatQueue, sessionId, text),
    dequeuePrompt: (sessionId, index) => call(IpcChannels.chatDequeue, sessionId, index),
    steerChat: (sessionId, text) => call(IpcChannels.chatSteer, sessionId, text),
  interruptQueuedPrompt: (sessionId, index, brain) => call(IpcChannels.chatInterruptQueued, sessionId, index, brain),
    resourceQueue: (action, input) => call(IpcChannels.resourceQueue, action, input),
  suggestReplies: (sessionId) => call(IpcChannels.chatSuggest, sessionId),
    fillPromptPart: (sessionId, part, draft) => call(IpcChannels.chatFillPrompt, sessionId, part, draft),
    approveTool: (sessionId, toolCallId, approved) => call(IpcChannels.toolApprove, sessionId, toolCallId, approved),
    answerQuestion: (sessionId, callId, answers) => call(IpcChannels.chatAnswer, sessionId, callId, answers),
    pendingInput: () => call(IpcChannels.chatPending),
    runningSessions: () => call(IpcChannels.chatRunning),

    listTerminals: () => call(IpcChannels.terminalsList),
    openTerminalStream: (id, handlers) => openTerminalStream(id, handlers),
    listShells: () => call(IpcChannels.terminalShells),
    createTerminal: (opts) => call(IpcChannels.terminalCreate, opts),
    terminalSnapshot: (id) => call(IpcChannels.terminalSnapshot, id),
    updateTerminal: (id, patch) => call(IpcChannels.terminalUpdate, id, patch),
    writeTerminal: (id, data) => call(IpcChannels.terminalWrite, id, data),
    resizeTerminal: (id, cols, rows) => call(IpcChannels.terminalResize, id, cols, rows),
    runInTerminal: (id, command) => call(IpcChannels.terminalRun, id, command),
    signalTerminal: (id, signal) => call(IpcChannels.terminalSignal, id, signal),
    closeTerminal: (id) => call(IpcChannels.terminalClose, id),

    previewContext: (sessionId, attachedPaths) => call(IpcChannels.contextPreview, sessionId, attachedPaths),
    toggleContextItem: (sessionId, itemId, included, pinned) =>
      call(IpcChannels.contextToggle, sessionId, itemId, included, pinned),
    setContextPrefs: (sessionId, prefs) => call(IpcChannels.contextSetPrefs, sessionId, prefs),

    buildSpec: (sessionId) => call(IpcChannels.specBuild, sessionId),
    buildSpecDoc: (sessionId, docId, workspaceId) => call(IpcChannels.specBuildDoc, sessionId, docId, workspaceId),
    readSpecDocs: (sessionId, workspaceId) => call(IpcChannels.specReadDocs, sessionId, workspaceId),
    setSpecMethodology: (sessionId, methodologyId) => call(IpcChannels.specSetMethodology, sessionId, methodologyId),
    toggleSpecTask: (sessionId, lineIndex, workspaceId) => call(IpcChannels.specToggleTask, sessionId, lineIndex, workspaceId),
    setSpecLinked: (sessionId, linked) => call(IpcChannels.specSetLinked, sessionId, linked),
    specPath: (sessionId) => call(IpcChannels.specPath, sessionId),
    configureSandbox: (id, image) => call(IpcChannels.sandboxConfigure, id, image),
  cleanupSandbox: (id, identity) => call(IpcChannels.sandboxCleanup, id, identity),
  sandboxStatus: (id) => call(IpcChannels.sandboxStatus, id),
  sandboxDiff: (id) => call(IpcChannels.sandboxDiff, id),
  applySandboxDiff: (id, identity, diffId, paths) => call(IpcChannels.sandboxApplyDiff, id, identity, diffId, paths) as Promise<never>,
  setSessionOptions: (id, patch) => call(IpcChannels.sessionSetOptions, id, patch),
    truncateSession: (id, messageId) => call(IpcChannels.sessionTruncate, id, messageId),
    clearSessions: (scope) => call(IpcChannels.sessionsClear, scope),
    purgeExpiredArchives: () => call(IpcChannels.sessionsPurgeArchived),
    forkSession: (id, beforeMessageId) => call(IpcChannels.sessionFork, id, beforeMessageId),
    resetSettings: () => call(IpcChannels.settingsReset),
    wipeAllData: () => call(IpcChannels.dataWipe),
    listTools: () => call(IpcChannels.toolsList),

    // No native picker in the browser, ask for server-side path(s).
    openFilesDialog: async () => {
      const p = window.prompt('File path(s) on the server to attach (comma-separated):');
      return p ? p.split(',').map((s) => s.trim()).filter(Boolean) : [];
    },
    // A browser never learns where a pasted file lives; everything is imported.
    pathForFile: () => '',
    importAttachment: (sessionId, name, dataUrl) => call(IpcChannels.attachmentImport, sessionId, name, dataUrl),
    openPath: async (target) => {
      window.open(/^https?:\/\//i.test(target) ? target : `file://${target}`, '_blank');
    },

    listMemory: (scope, workspaceId) => call(IpcChannels.memoryList, scope, workspaceId),
    saveMemory: (entry) => call(IpcChannels.memorySave, entry),
    deleteMemory: (id) => call(IpcChannels.memoryDelete, id),

    listWorkspaces: () => call(IpcChannels.workspaceList),
    // No native folder picker in the browser, ask for a server-side path.
    pickFolder: async () => promptFolder(),
    addWorkspace: async () => {
      const p = promptFolder();
      return p ? call(IpcChannels.workspaceAddByPath, p) : call(IpcChannels.workspaceList);
    },
    addWorkspaceByPath: (path) => call(IpcChannels.workspaceAddByPath, path),
    removeWorkspace: (id) => call(IpcChannels.workspaceRemove, id),
    indexWorkspace: (id) => call(IpcChannels.workspaceIndex, id),
    getIndexStatus: (id) => call(IpcChannels.workspaceIndexStatus, id),
    searchWorkspace: (id, query) => call(IpcChannels.workspaceSearch, id, query),
    listFiles: (id) => call(IpcChannels.workspaceFiles, id),
    getGitStatus: (id, force) => call(IpcChannels.workspaceGitStatus, id, force),
    listChatWorktrees: () => call(IpcChannels.chatWorktreesList),
    removeChatWorktree: (root) => call(IpcChannels.chatWorktreesRemove, root),

    readFile: (path) => call(IpcChannels.fileRead, path),
    writeFile: (path, content) => call(IpcChannels.fileWrite, path, content),
    listDir: (path) => call(IpcChannels.dirList, path),
    fetchRemoteImage: (url) => call(IpcChannels.imageFetch, url),

    listChanges: (sessionId) => call(IpcChannels.changesList, sessionId),
    acceptChange: (sessionId, path) => call(IpcChannels.changeAccept, sessionId, path),
    acceptAllChanges: (sessionId) => call(IpcChannels.changeAcceptAll, sessionId),

    listSessionPrs: (sessionId, force) => call(IpcChannels.prSessionList, sessionId, force),
    getPrDiff: (url) => call(IpcChannels.prDiff, url),
    prAction: (url, action) => call(IpcChannels.prAction, url, action),
    continuePrStack: (sessionId, url) => call(IpcChannels.prContinueStack, sessionId, url),
    linkPrStack: (sessionId, url) => call(IpcChannels.prLinkStack, sessionId, url),

    listComments: (path) => call(IpcChannels.commentsList, path),
    addComment: (path, line, lineText, comment) => call(IpcChannels.commentAdd, path, line, lineText, comment),
    resolveComment: (path, id) => call(IpcChannels.commentResolve, path, id),

    getDesignBoard: (workspaceId) => call(IpcChannels.designGet, workspaceId),
    addDesignPage: (workspaceId, label, url) => call(IpcChannels.designAddPage, workspaceId, label, url),
    updateDesignPage: (workspaceId, pageId, patch) => call(IpcChannels.designUpdatePage, workspaceId, pageId, patch),
    removeDesignPage: (workspaceId, pageId) => call(IpcChannels.designRemovePage, workspaceId, pageId),
    addDesignNote: (workspaceId, pageId, text) => call(IpcChannels.designAddNote, workspaceId, pageId, text),
    resolveDesignNote: (workspaceId, pageId, noteId) => call(IpcChannels.designResolveNote, workspaceId, pageId, noteId),
    generateDesign: (workspaceId, input) => call(IpcChannels.designGenerate, workspaceId, input),

    listInstalledSkills: () => call(IpcChannels.skillsInstalled),
        listExternalSkills: () => call(IpcChannels.skillsExternal),
    skillTargets: () => call(IpcChannels.skillsTargets),
    installSkill: (skillId, target, payload) => call(IpcChannels.skillInstall, skillId, target, payload),
    uninstallSkill: (skillId, target) => call(IpcChannels.skillUninstall, skillId, target),
    vaizerCatalog: (refresh) => call(IpcChannels.vaizerCatalog, refresh),
    listSkillSources: (refresh) => call(IpcChannels.skillSourcesList, refresh),
    previewSkillUrl: (input) => call(IpcChannels.skillSourcesPreview, input),
    fetchRemoteSkill: (skill) => call(IpcChannels.skillSourcesFetch, skill),
    searchSkills: (query) => call(IpcChannels.skillSourcesSearch, query),
    vaizerSkillMd: (slug) => call(IpcChannels.vaizerSkillMd, slug),

    listTasks: () => call(IpcChannels.tasksList),
    createTask: (task) => call(IpcChannels.taskCreate, task),
    updateTask: (id, patch) => call(IpcChannels.taskUpdate, id, patch),
    deleteTask: (id) => call(IpcChannels.taskDelete, id),
    runTaskNow: (id) => call(IpcChannels.taskRunNow, id),

    listTrainingRuns: () => call(IpcChannels.trainingList),
    createTrainingRun: (input) => call(IpcChannels.trainingCreate, input),
    updateTrainingRun: (id, patch) => call(IpcChannels.trainingUpdate, id, patch),
    deleteTrainingRun: (id) => call(IpcChannels.trainingDelete, id),
    startTrainingRun: (id) => call(IpcChannels.trainingStart, id),
    pauseTrainingRun: (id) => call(IpcChannels.trainingPause, id),
    stopTrainingRun: (id) => call(IpcChannels.trainingStop, id),
    addTrainingHint: (id, text) => call(IpcChannels.trainingHint, id, text),

    listWorkflows: () => call(IpcChannels.workflowsList),
    createWorkflow: (input) => call(IpcChannels.workflowCreate, input),
    updateWorkflow: (id, patch) => call(IpcChannels.workflowUpdate, id, patch),
    deleteWorkflow: (id) => call(IpcChannels.workflowDelete, id),
    duplicateWorkflow: (id) => call(IpcChannels.workflowDuplicate, id),
    runWorkflow: (id) => call(IpcChannels.workflowRun, id),
    cancelWorkflowRun: (runId) => call(IpcChannels.workflowCancel, runId),
    listWorkflowRuns: (workflowId) => call(IpcChannels.workflowRuns, workflowId),
    dispatchWorkflowEvent: (event) => call(IpcChannels.workflowEvent, event),

    listConnectors: () => call(IpcChannels.connectorsList),
    connectConnector: (kind, t, settings) => call(IpcChannels.connectorConnect, kind, t, settings),
    disconnectConnector: (kind) => call(IpcChannels.connectorDisconnect, kind),
    fetchConnector: (kind, query) => call(IpcChannels.connectorFetch, kind, query),

    detectAgentTools: () => call(IpcChannels.integrationsDetect),
    installSubagent: (tool, target) => call(IpcChannels.integrationsInstall, tool, target),
    subagentSnippet: (tool, target) => call(IpcChannels.integrationsSnippet, tool, target),

    classifyCommand: (command) => call(IpcChannels.guardrailsClassify, command),
    saveGuardrail: async (rule) => {
      const settings: AppSettings = await call(IpcChannels.settingsGet);
      const guardrails = settings.guardrails.filter((g) => g.id !== rule.id);
      guardrails.push(rule);
      const updated: AppSettings = await call(IpcChannels.settingsUpdate, { guardrails });
      return updated.guardrails;
    },

    getUsageSummary: () => call(IpcChannels.usageSummary),
    getLimits: (tokenKey, refresh) => call(IpcChannels.limitsGet, tokenKey, refresh),
    getLimitsProblem: (tokenKey) => call(IpcChannels.limitsProblem, tokenKey),

    oauthBegin: (provider) => call(IpcChannels.oauthBegin, provider),
    oauthFinish: (sessionId, pasted) => call(IpcChannels.oauthFinish, sessionId, pasted),
    oauthCancel: (sessionId) => call(IpcChannels.oauthCancel, sessionId),
    oauthStatus: (providerConfigId) => call(IpcChannels.oauthStatus, providerConfigId),
    oauthSignOut: (providerConfigId) => call(IpcChannels.oauthSignOut, providerConfigId),
    importCliAuth: () => call(IpcChannels.providersImportCliAuth),

    enableRemote: (relayUrl) => call(IpcChannels.remoteEnable, relayUrl),
    disableRemote: () => call(IpcChannels.remoteDisable),
    getRemoteStatus: () => call(IpcChannels.remoteStatus),
    getMessagingStatus: () => call(IpcChannels.messagingStatus),
    getRemotePairing: () => call(IpcChannels.remotePairing),
    startRemotePairing: () => call(IpcChannels.remotePair),
    listRemoteDevices: () => call(IpcChannels.remoteDevices),
    revokeRemoteDevice: (deviceId) => call(IpcChannels.remoteRevoke, deviceId),
    renameRemoteDevice: (deviceId, name) => call(IpcChannels.remoteRename, deviceId, name),
    rotateRemoteSecret: () => call(IpcChannels.remoteRotate),
    // The web and self-hosted editions run on a server: the relay that ships beside
    // them is apps/relay-server itself, so there is nothing for this page to start.
    localRelayStatus: async () => webLocalRelay,
    localRelayStart: async () => webLocalRelay,
    localRelayStop: async () => webLocalRelay,
    localRelaySetLan: async () => webLocalRelay,
    networkVisibilityStatus: async () => webVisibility,
    networkVisibilityStart: async () => webVisibility,
    networkVisibilityStop: async () => webVisibility,

    // Local Web UI: "update" = the server got a newer build since this tab
    // loaded; we just suggest a refresh (no installer to run in the browser).
    getAppInfo: () => call(IpcChannels.appInfo) as Promise<AppInfo>,
    getClaudePolicy: () => call(IpcChannels.claudePolicy) as Promise<ClaudePolicyStatus>,
    getClaudeCapability: (providerId, capability) => call(IpcChannels.claudeCapability, providerId, capability) as Promise<ClaudeCapabilityStatus>,
    getClaudePlanUsage: (providerId) => call(IpcChannels.claudePlanUsage, providerId) as Promise<ClaudePlanUsageStatus>,
    getClaudeCodeStatus: (providerId) => call(IpcChannels.claudeCodeStatus, providerId) as Promise<ClaudeCodeStatus>,
    getMcpStatus: () => call(IpcChannels.mcpStatus),
    detectHypergate: (port) => call(IpcChannels.mcpHypergate, port),
    connectHypergate: (port) => call(IpcChannels.mcpHypergateConnect, port),
    registerPushToken: (token, platform) => registerPush(token, platform),
    checkForUpdates: async () => {
      const info = (await call(IpcChannels.appInfo)) as AppInfo;
      if (loadVersion === null) loadVersion = info.version;
      const stale = info.version !== loadVersion;
      return {
        state: stale ? 'available' : 'none',
        currentVersion: loadVersion,
        version: stale ? info.version : undefined,
        notesUrl: RELEASE_NOTES_URL,
        edition: 'web',
      } as UpdateInfo;
    },
    downloadUpdate: async () =>
      ({ state: 'available', currentVersion: loadVersion ?? '', notesUrl: RELEASE_NOTES_URL, edition: 'web' } as UpdateInfo),
    quitAndInstall: async () => {
      location.reload();
    },
    runUpdateChecks: () => call(IpcChannels.updatesCheck),

    onAgentEvent: (cb) => {
      agentCbs.add(cb);
      return () => agentCbs.delete(cb);
    },
    subscribeAgentEvents: (ids) => subscribe(ids),
    onAgentReplay: (cb) => {
      replayCbs.add(cb);
      return () => replayCbs.delete(cb);
    },
    onOAuthStatus: (cb) => {
      oauthStatusCbs.add(cb);
      return () => oauthStatusCbs.delete(cb);
    },
    onIndexProgress: (cb) => {
      indexCbs.add(cb);
      return () => indexCbs.delete(cb);
    },
    onTerminalEvent: (cb) => {
      terminalCbs.add(cb);
      return () => terminalCbs.delete(cb);
    },
    onChangesUpdated: (cb) => {
      changesCbs.add(cb);
      return () => changesCbs.delete(cb);
    },
    onTasksUpdated: (cb) => {
      tasksCbs.add(cb);
      return () => tasksCbs.delete(cb);
    },
    onTrainingUpdated: (cb) => {
      trainingCbs.add(cb);
      return () => trainingCbs.delete(cb);
    },
    onWorkflowsUpdated: (cb) => {
      workflowCbs.add(cb);
      return () => workflowCbs.delete(cb);
    },
    onLimitsUpdated: (cb) => {
      limitsUpdatedCbs.add(cb);
      return () => limitsUpdatedCbs.delete(cb);
    },
    onDownloadsUpdated: (cb) => {
      downloadsUpdatedCbs.add(cb);
      return () => downloadsUpdatedCbs.delete(cb);
    },
    onModelsUpdated: (cb) => {
      modelsUpdatedCbs.add(cb);
      return () => modelsUpdatedCbs.delete(cb);
    },
    onSkillsUpdated: (cb) => {
      skillsUpdatedCbs.add(cb);
      return () => skillsUpdatedCbs.delete(cb);
    },
    // A browser tab has no OS handing it `nekko-agent://` URLs, so this is the
    // honest implementation rather than a missing one.
    onDeepLink: () => () => {},
    onUpdateEvent: (cb) => {
      // Poll the server version; emit 'available' once it differs from load.
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const info = (await call(IpcChannels.appInfo)) as AppInfo;
          if (loadVersion === null) loadVersion = info.version;
          else if (info.version !== loadVersion) {
            cb({ state: 'available', currentVersion: loadVersion, version: info.version, notesUrl: RELEASE_NOTES_URL, edition: 'web' });
          }
        } catch {
          /* server momentarily unreachable */
        }
      };
      void tick();
      const timer = setInterval(tick, 60000);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

/** Install the web client only if no Electron preload bridge already set window.nekko. */
export function ensureNekko(): void {
  if (!(window as any).nekko) {
    (window as any).nekko = makeWebClient();
  }
}
