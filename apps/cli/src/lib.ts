import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHost, defaultUserDataDir, prepareUserDataRoot } from '@nekko-agent/host';
import { brandEnv, CLI_LINK_FILE, isCliLink, IpcEvents, unsupportedPlatformReason, type CliLink } from '@nekko-agent/shared';
import type {
  AppSettings,
  Session,
  SendOptions,
  AgentEvent,
  WorkspaceFolder,
  RemoteStatus,
  TrainingRun,
  NewTrainingRun,
  WorkflowEvent,
  WorkflowRun,
  WorkflowsSnapshot,
  ModelInfo,
  ProviderConfig,
  IndexStatus,
  SearchHit,
  AutomationTask,
  NewTask,
  InstalledSkillRecord,
  InstallTarget,
  MarketplaceSkill,
  UsageSummary,
  VaizerCatalog,
} from '@nekko-agent/shared';

/** The data dir for the in-process (local) client. NEKKO_DATA_DIR wins, then ~/.nekko. */
export function dataDir(): string {
  return defaultUserDataDir();
}

/**
 * The address + token the installed app left for us, if it has.
 *
 * This is what makes a freshly installed CLI work with nothing exported: the
 * app writes the file whenever its server settings change (see the desktop
 * `cli-link` module). A file that says `enabled: false` is not a target, but
 * it is not nothing either, so it comes back and the caller can say the app
 * is not serving rather than quietly opening the data directory behind it.
 */
export function readCliLink(dir = dataDir()): CliLink | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, CLI_LINK_FILE), 'utf8'));
    return isCliLink(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Where a client should point, and why. Flags beat env, env beats the link
 * file the app wrote, and with none of those there is no server: the CLI opens
 * the data directory itself.
 */
export function resolveTarget(opts: { url?: string; token?: string } = {}): {
  url?: string;
  token?: string;
  source: 'flag' | 'env' | 'app' | 'local';
} {
  if (opts.url) return { url: opts.url, token: opts.token ?? brandEnv('TOKEN'), source: 'flag' };
  const envUrl = brandEnv('URL');
  if (envUrl) return { url: envUrl, token: opts.token ?? brandEnv('TOKEN'), source: 'env' };
  const link = readCliLink();
  if (link?.enabled && appAlive(link.pid)) return { url: link.url, token: opts.token ?? link.token, source: 'app' };
  return { source: 'local' };
}

/**
 * Whether the app that wrote the link is still running. Signal 0 checks for a
 * process without touching it; EPERM means it exists but is not ours to signal,
 * which still counts as alive. A link with no pid (an older app) is trusted.
 */
function appAlive(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The subset of the host surface the CLI/MCP use, async so the same code drives
 * either an in-process host (local data dir) or a running server over HTTP+WS.
 */
export interface Client {
  ready(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listProviders(): Promise<ProviderConfig[]>;
  listModels(providerId: string): Promise<ModelInfo[]>;
  listSessions(): Promise<Session[]>;
  createSession(workspaceId?: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listWorkspaces(): Promise<WorkspaceFolder[]>;
  addWorkspaceByPath(path: string): Promise<WorkspaceFolder[]>;
  removeWorkspace(id: string): Promise<WorkspaceFolder[]>;
  indexWorkspace(id: string): Promise<IndexStatus>;
  searchWorkspace(id: string, query: string): Promise<SearchHit[]>;
  listTasks(): Promise<AutomationTask[]>;
  createTask(task: NewTask): Promise<AutomationTask[]>;
  runTaskNow(id: string): Promise<void>;
  deleteTask(id: string): Promise<AutomationTask[]>;
  listInstalledSkills(): Promise<InstalledSkillRecord[]>;
  installSkill(
    skillId: string,
    target: InstallTarget,
    payload?: MarketplaceSkill,
  ): Promise<{ ok: boolean; message?: string; installed: InstalledSkillRecord[] }>;
  vaizerCatalog(refresh?: boolean): Promise<VaizerCatalog>;
  vaizerSkillMd(slug: string): Promise<string | null>;
  listTools(): Promise<Array<{ name: string; description: string }>>;
  usageSummary(): Promise<UsageSummary>;
  remoteStatus(): Promise<RemoteStatus>;
  sendChat(opts: SendOptions): Promise<void>;
  abortChat(sessionId: string): Promise<void>;
  approveTool(sessionId: string, callId: string, approved: boolean): Promise<void>;
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  setSessionOptions(id: string, patch: Partial<Pick<Session, 'mode' | 'disabledTools' | 'title'>>): Promise<void>;
  listTrainingRuns(): Promise<TrainingRun[]>;
  createTrainingRun(input: NewTrainingRun): Promise<TrainingRun>;
  startTrainingRun(id: string): Promise<TrainingRun[]>;
  stopTrainingRun(id: string): Promise<TrainingRun[]>;
  addTrainingHint(id: string, text: string): Promise<TrainingRun[]>;
  listWorkflows(): Promise<WorkflowsSnapshot>;
  runWorkflow(id: string): Promise<WorkflowRun | undefined>;
  dispatchWorkflowEvent(event: WorkflowEvent): Promise<WorkflowRun[]>;
}

/** In-process client backed by createHost on the data dir. */
function localClient(): Client {
  // A remote client (--url) still works from an Intel Mac; a local engine does not.
  const unsupported = unsupportedPlatformReason(process.platform, process.arch);
  if (unsupported) throw new Error(unsupported);
  const host = createHost({ dataDir: prepareUserDataRoot() });
  return {
    ready: async () => {},
    getSettings: async () => host.getSettings(),
    updateSettings: async (patch) => host.updateSettings(patch),
    listProviders: async () => host.listProviders(),
    listModels: async (id) => host.listModels(id),
    listSessions: async () => host.listSessions(),
    createSession: async (w) => host.createSession(w),
    getSession: async (id) => host.getSession(id),
    listWorkspaces: async () => host.listWorkspaces(),
    addWorkspaceByPath: async (path) => host.addWorkspaceByPath(path),
    removeWorkspace: async (id) => host.removeWorkspace(id),
    indexWorkspace: async (id) => host.indexWorkspace(id),
    searchWorkspace: async (id, query) => host.searchWorkspace(id, query),
    listTasks: async () => host.listTasks(),
    createTask: async (task) => host.createTask(task),
    runTaskNow: async (id) => host.runTaskNow(id),
    deleteTask: async (id) => host.deleteTask(id),
    listInstalledSkills: async () => host.listInstalledSkills(),
    installSkill: async (id, target, payload) => host.installSkill(id, target, payload),
    vaizerCatalog: async (refresh) => host.vaizerCatalog(refresh),
    vaizerSkillMd: async (slug) => host.vaizerSkillMd(slug),
    listTools: async () => host.listTools(),
    usageSummary: async () => host.usageSummary(),
    remoteStatus: async () => host.remoteStatus(),
    sendChat: (o) => host.sendChat(o),
    abortChat: async (id) => host.abortChat(id),
    approveTool: async (s, c, a) => host.approveTool(s, c, a),
    onAgentEvent: (cb) => {
      host.events.on('agentEvent', cb);
      return () => host.events.off('agentEvent', cb);
    },
    setSessionOptions: async (i, p) => void host.setSessionOptions(i, p),
    listTrainingRuns: async () => host.listTrainingRuns(),
    createTrainingRun: async (input) => host.createTrainingRun(input),
    startTrainingRun: async (id) => host.startTrainingRun(id),
    stopTrainingRun: async (id) => host.stopTrainingRun(id),
    addTrainingHint: async (id, text) => host.addTrainingHint(id, text),
    listWorkflows: async () => host.listWorkflows(),
    runWorkflow: (id) => host.runWorkflow(id),
    dispatchWorkflowEvent: (event) => host.dispatchWorkflowEvent(event),
  };
}

/** Remote client over a running server's HTTP (`POST /api/:channel`) + WS events. */
function httpClient(url: string, token?: string): Client {
  const base = url.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const call = async (channel: string, ...args: unknown[]) => {
    const res = await fetch(`${base}/api/${channel}`, { method: 'POST', headers, body: JSON.stringify({ args }) });
    if (!res.ok) throw new Error(`${channel}: HTTP ${res.status}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };

  const cbs = new Set<(e: AgentEvent) => void>();
  let ws: WebSocket | null = null;
  let openP: Promise<void> | null = null;
  const connect = () => {
    if (openP) return openP;
    const wsUrl = `${base.replace(/^http/, 'ws')}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
      try {
        const { channel, payload } = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (channel === IpcEvents.agentEvent) cbs.forEach((cb) => cb(payload));
      } catch {
        /* ignore */
      }
    };
    openP = new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = () => reject(new Error(`Cannot reach Nekko Agent server at ${base}`));
    });
    return openP;
  };

  return {
    ready: () => connect(),
    getSettings: () => call('settings:get'),
    updateSettings: (patch) => call('settings:update', patch),
    listProviders: () => call('providers:list'),
    listModels: (id) => call('models:list', id),
    listSessions: () => call('sessions:list'),
    createSession: (w) => call('session:create', w),
    getSession: (id) => call('session:get', id),
    listWorkspaces: () => call('workspace:list'),
    addWorkspaceByPath: (path) => call('workspace:addByPath', path),
    removeWorkspace: (id) => call('workspace:remove', id),
    indexWorkspace: (id) => call('workspace:index', id),
    searchWorkspace: (id, query) => call('workspace:search', id, query),
    listTasks: () => call('tasks:list'),
    createTask: (task) => call('task:create', task),
    runTaskNow: (id) => call('task:runNow', id),
    deleteTask: (id) => call('task:delete', id),
    listInstalledSkills: () => call('skills:installed'),
    installSkill: (id, target, payload) => call('skill:install', id, target, payload),
    vaizerCatalog: (refresh) => call('vaizer:catalog', refresh),
    vaizerSkillMd: (slug) => call('vaizer:skillMd', slug),
    listTools: () => call('tools:list'),
    usageSummary: () => call('usage:summary'),
    remoteStatus: () => call('remote:status'),
    sendChat: (o) => call('chat:send', o),
    abortChat: (id) => call('chat:abort', id),
    approveTool: (s, c, a) => call('tool:approve', s, c, a),
    onAgentEvent: (cb) => {
      cbs.add(cb);
      void connect();
      return () => cbs.delete(cb);
    },
    setSessionOptions: (i, p) => call('session:setOptions', i, p).then(() => undefined),
    listTrainingRuns: () => call('training:list'),
    createTrainingRun: (input) => call('training:create', input),
    startTrainingRun: (id) => call('training:start', id),
    stopTrainingRun: (id) => call('training:stop', id),
    addTrainingHint: (id, text) => call('training:hint', id, text),
    listWorkflows: () => call('workflows:list'),
    runWorkflow: (id) => call('workflow:run', id),
    dispatchWorkflowEvent: (event) => call('workflow:event', event),
  };
}

/**
 * Build a client: `--url`, else NEKKO_URL, else the running app's link file,
 * else an in-process host on the local data directory.
 */
export function getClient(opts: { url?: string; token?: string } = {}): Client {
  const target = resolveTarget(opts);
  return target.url ? httpClient(target.url, target.token) : localClient();
}

/** Resolve provider + model from flags, the session, then saved defaults. */
export function resolveModel(
  settings: AppSettings,
  opts: { provider?: string; model?: string; sessionProvider?: string; sessionModel?: string },
): { providerId: string; modelId: string } {
  const providerId = opts.provider || opts.sessionProvider || settings.defaultProviderId || settings.providers[0]?.id;
  const modelId = opts.model || opts.sessionModel || settings.defaultModelId;
  if (!providerId) throw new Error('No provider configured. Add one in the app, or pass --provider.');
  if (!modelId) throw new Error('No model selected. Pass --model, or set a default in the app.');
  return { providerId, modelId };
}

/** Run one chat turn to completion, streaming text and structured events. */
export async function runChat(
  client: Client,
  args: {
    sessionId: string;
    providerId: string;
    modelId: string;
    text: string;
    approve?: ApprovalPolicy;
    timeoutMs?: number;
    onText?: (s: string) => void;
    onEvent?: (event: ChatOutputEvent) => void;
  },
): Promise<ChatRunResult> {
  const policy = args.approve ?? approvalPolicy();
  const session = await client.getSession(args.sessionId);
  if (!session) throw new Error(`Session ${args.sessionId} not found`);
  const originalMode = session.mode;
  await client.setSessionOptions(args.sessionId, { mode: policy === 'ask' ? 'ask' : policy });
  try {
    await client.ready();
  } catch (error) {
    await client.setSessionOptions(args.sessionId, { mode: originalMode });
    throw error;
  }
  return new Promise((resolve, reject) => {
    let out = '';
    const toolCalls: ChatToolCall[] = [];
    const blocked: BlockedEntry[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const restore = async () => {
      await client.setSessionOptions(args.sessionId, { mode: originalMode });
    };
    const finish = async (result: ChatRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      off();
      try {
        await restore();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    const fail = async (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      off();
      try {
        await restore();
      } finally {
        reject(error);
      }
    };
    const off = client.onAgentEvent((e) => {
      if (e.sessionId !== args.sessionId) return;
      switch (e.type) {
        case 'text':
          out += e.delta;
          args.onText?.(e.delta);
          args.onEvent?.({ type: 'text', delta: e.delta });
          break;
        case 'tool_call':
          toolCalls.push({ id: e.call.id, name: e.call.name, input: e.call.input });
          args.onEvent?.({ type: 'tool_call', call: { name: e.call.name, input: e.call.input } });
          break;
        case 'tool_result':
          {
            const call = toolCalls.find((item) => item.id === e.result.toolCallId);
            if (call) {
              call.ok = !e.result.isError;
              if (e.result.isError) call.error = e.result.output;
            }
          }
          args.onEvent?.({
            type: 'tool_result',
            toolCallId: e.result.toolCallId,
            ok: !e.result.isError,
            output: e.result.output,
          });
          break;
        case 'tool_approval_required':
          {
            const entry: BlockedEntry = {
              ruleLabels: e.reason ? [e.reason] : [],
              command: typeof e.call.input.command === 'string' ? e.call.input.command : undefined,
              severity: e.severity,
              reason: e.reason,
            };
            if (policy === 'guardrails') {
              blocked.push(entry);
              args.onEvent?.({ type: 'blocked', ...entry });
              void client.approveTool(e.sessionId, e.call.id, false);
            } else if (policy === 'yolo') {
              void client.approveTool(e.sessionId, e.call.id, true);
            } else {
              void askApproval(e.call.name, e.call.input)
                .then((approved) => client.approveTool(e.sessionId, e.call.id, approved))
                .catch(fail);
            }
          }
          break;
        case 'usage':
          usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens };
          break;
        case 'done':
          args.onEvent?.({ type: 'done' });
          void finish({ text: out, toolCalls, blocked, durationMs: Date.now() - started, usage });
          break;
        case 'error':
          args.onEvent?.({ type: 'error', message: e.message });
          void fail(new Error(e.message));
          break;
      }
    });
    client
      .sendChat({ sessionId: args.sessionId, providerId: args.providerId, modelId: args.modelId, text: args.text })
      .catch((err) => {
        void fail(err);
      });
    const timeoutMs = args.timeoutMs;
    if (timeoutMs) {
      timer = setTimeout(() => {
        void client.abortChat(args.sessionId);
        void fail(new Error(`Chat timed out after ${timeoutMs / 1000} seconds`));
      }, timeoutMs);
    }
  });
}

export type ApprovalPolicy = 'guardrails' | 'yolo' | 'ask';
export type ChatToolCall = {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  ok?: boolean;
  error?: string;
};
export type BlockedEntry = {
  ruleLabels: string[];
  command?: string;
  severity: 'low' | 'medium' | 'high';
  reason: string;
};
export type ChatOutputEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: { name: string; input: Record<string, unknown> } }
  | { type: 'tool_result'; toolCallId: string; ok: boolean; output: string }
  | ({ type: 'blocked' } & BlockedEntry)
  | { type: 'done' }
  | { type: 'error'; message: string };
export interface ChatRunResult {
  text: string;
  toolCalls: ChatToolCall[];
  blocked: BlockedEntry[];
  durationMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export function approvalPolicy(value = brandEnv('APPROVE')): ApprovalPolicy {
  if (!value) return 'guardrails';
  if (value === 'guardrails' || value === 'yolo' || value === 'ask') return value;
  throw new Error(`Invalid approval policy "${value}". Use guardrails, yolo, or ask.`);
}

async function askApproval(name: string, input: Record<string, unknown>): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error('Approval policy "ask" requires an interactive TTY.');
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Approve ${name} ${JSON.stringify(input)}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
