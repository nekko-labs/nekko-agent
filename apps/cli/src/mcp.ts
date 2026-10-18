import { INSTALL_TARGETS, normalizeInstallTarget } from '@nekko-agent/shared';
import { getClient, resolveModel, runChat, approvalPolicy, type Client } from './lib.js';
import { resolveInstall } from './skills.js';
import {
  downloadModel,
  listLocalModels,
  loadModel,
  localModelStatus,
  searchCatalog,
  startRuntime,
  stopRuntime,
  summarizeDownload,
  unloadModel,
} from './local-models.js';
import { VERSION } from './version.js';

/**
 * MCP stdio server exposing Nekko Agent to other tools (Claude Code, Codex, …).
 * Hand-rolled JSON-RPC 2.0 over newline-delimited stdio, the MCP stdio
 * transport. Other agents can trigger this machine's agent, make chat requests,
 * spin up sessions (swarm by calling chat across several sessions), and read
 * status, all driving the local model.
 */

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const TOOLS = [
  {
    name: 'nekko-agent_chat',
    description:
      "Run an agent turn on this machine's Nekko Agent (reads/edits/searches/runs in the configured workspace, using the local or cloud model). Returns the assistant's reply. Omit sessionId to start a fresh session.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to ask / tell the agent.' },
        sessionId: { type: 'string', description: 'Continue an existing chat (optional).' },
        workspaceId: { type: 'string', description: 'Workspace/project to scope a new chat to (optional).' },
        provider: { type: 'string', description: 'Provider id override (optional). For a local model, the providerId nekko-agent_model_load returned.' },
        model: { type: 'string', description: 'Model id override (optional). For a local model, its id from nekko-agent_local_models.' },
        approve: { type: 'string', enum: ['guardrails', 'yolo', 'ask'], description: 'Tool approval policy (default guardrails).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'nekko-agent_list_sessions',
    description: 'List chat sessions (id, title, message count, last updated).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_new_session',
    description: 'Create a new chat session and return its id.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } } },
  },
  {
    name: 'nekko-agent_get_session',
    description: 'Get a session transcript (user/assistant messages).',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
  },
  {
    name: 'nekko-agent_workspace_list',
    description: 'List configured workspaces.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_workspace_add',
    description: 'Add a workspace by filesystem path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'nekko-agent_workspace_remove',
    description: 'Remove a configured workspace.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] },
  },
  {
    name: 'nekko-agent_workspace_index',
    description: 'Index a configured workspace.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] },
  },
  {
    name: 'nekko-agent_workspace_search',
    description: 'Search an indexed workspace.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, query: { type: 'string' } }, required: ['workspaceId', 'query'] },
  },
  {
    name: 'nekko-agent_prompts_list',
    description: 'List saved prompts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_tasks_list',
    description: 'List automation tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_task_create',
    description: 'Create an automation task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable task name.' },
        prompt: { type: 'string', description: 'Instruction to run on each task execution.' },
        kind: { type: 'string', enum: ['scheduled', 'recurring', 'background'], description: 'Task schedule type.' },
        runAt: { type: 'number', description: 'Scheduled execution time as epoch milliseconds.' },
        intervalMs: { type: 'number', description: 'Recurring/background interval in milliseconds.' },
        workspaceId: { type: 'string', description: 'Workspace used by the task.' },
        providerId: { type: 'string', description: 'Provider override.' },
        modelId: { type: 'string', description: 'Model override.' },
        condition: { type: 'string', description: 'Background until-condition.' },
        keepAlive: { type: 'string', enum: ['forever', 'until'], description: 'Background lifetime policy.' },
      },
      required: ['title', 'prompt', 'kind'],
    },
  },
  {
    name: 'nekko-agent_task_run',
    description: 'Run an automation task immediately.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'nekko-agent_task_delete',
    description: 'Delete an automation task.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'nekko-agent_skills_list',
    description: 'List installed skills.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_skill_install',
    description: 'Install a skill.',
    inputSchema: { type: 'object', properties: { skillId: { type: 'string' }, target: { type: 'string', enum: INSTALL_TARGETS } }, required: ['skillId'] },
  },
  {
    name: 'nekko-agent_tools_list',
    description: 'List host tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_models_list',
    description: 'List models for a provider.',
    inputSchema: { type: 'object', properties: { providerId: { type: 'string' } }, required: ['providerId'] },
  },
  {
    name: 'nekko-agent_train_start',
    description:
      "Ask this machine's Nekko Agent to train a model for a purpose. Creates and starts a training run: a local data-scientist agent works hands-on in the workspace (benchmark candidate models, prepare data, fine-tune, evaluate), reporting each experiment with its score to an experiment tree. Returns the run id; poll nekko-agent_train_status.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short run name, e.g. "mynichi-slm-v1".' },
        goal: { type: 'string', description: 'What to train and what metric to maximize/minimize, in plain language.' },
        kind: { type: 'string', enum: ['training', 'goal'], description: 'Run type (default "training").' },
        workspaceId: { type: 'string', description: 'Workspace the agent works in (see nekko-agent_status).' },
        provider: { type: 'string', description: 'Provider id override for the agent model (optional).' },
        model: { type: 'string', description: 'Model id override for the agent model (optional).' },
        metric: { type: 'string', description: 'Metric name experiments report, e.g. "score" or "accuracy".' },
        minimizeMetric: { type: 'boolean', description: 'True if lower is better (default false).' },
        maxExperiments: { type: 'number', description: 'Budget hint: stop after this many experiments.' },
        timeBudgetMin: { type: 'number', description: 'Budget hint: total minutes.' },
        extra: { type: 'string', description: 'Expert notes appended verbatim to the agent brief (exact commands, constraints, search space).' },
        approve: { type: 'string', enum: ['guardrails', 'yolo', 'ask'], description: 'Approval policy; unattended runs should explicitly use yolo.' },
      },
      required: ['name', 'goal'],
    },
  },
  {
    name: 'nekko-agent_train_status',
    description:
      'Status of training runs: experiments with scores, the current leader, run state. Pass runId for one run in detail, omit for a summary of all runs.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
  },
  {
    name: 'nekko-agent_train_hint',
    description: 'Queue user guidance for a running training run; the agent folds it into its next experiments.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, text: { type: 'string' } },
      required: ['runId', 'text'],
    },
  },
  {
    name: 'nekko-agent_train_stop',
    description: 'Stop a training run (the in-flight iteration finishes, then the run ends).',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
  },
  {
    name: 'nekko-agent_local_status',
    description:
      "State of this machine's local model serving: the built-in engine (installed, running, which models are loaded, memory budget) and any other local runtime (Ollama, LM Studio, vLLM). Call this first before loading or downloading a model.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_local_models',
    description:
      'Models already downloaded to this machine\'s engine library: id, size, quantization, whether loaded, and whether it fits in GPU memory (fit: full|partial|cpu|wont). Use an id from here with nekko-agent_model_load.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nekko-agent_model_search',
    description:
      'Search Hugging Face for GGUF models the engine can download (omit query for the curated starter list). Returns ids (owner/repo) and the quantizations each publishes with sizes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "qwen3 4b" or "gemma coder".' } } },
  },
  {
    name: 'nekko-agent_model_download',
    description:
      'Start downloading a model into the engine library. Returns immediately with a job id; poll nekko-agent_downloads for progress. Check the size against nekko-agent_local_status memory first; models are often several GB.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Hugging Face repo id from nekko-agent_model_search, e.g. "unsloth/Qwen3-4B-GGUF".' },
        quant: { type: 'string', description: 'Quantization label, e.g. "Q4_K_M" (optional; defaults to Q4_K_M or the closest available).' },
      },
      required: ['modelId'],
    },
  },
  {
    name: 'nekko-agent_downloads',
    description: 'Progress of model downloads: state (queued|downloading|verifying|done|failed|cancelled), percent, size and ETA.',
    inputSchema: { type: 'object', properties: { active: { type: 'boolean', description: 'Only downloads still in progress (default false).' } } },
  },
  {
    name: 'nekko-agent_download_cancel',
    description: 'Cancel a model download by job id.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'nekko-agent_model_load',
    description:
      "Run a local model: load it into the built-in engine (starting the engine if needed) or into another local runtime via providerId. Afterwards, send it work with nekko-agent_chat using the returned provider and model.",
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model id from nekko-agent_local_models (or the runtime\'s own model name for Ollama/LM Studio).' },
        providerId: { type: 'string', description: 'Local runtime provider (optional; default the built-in engine).' },
        contextTokens: { type: 'number', description: 'Context window to allocate (optional; leave unset for the engine default). A nekko-agent_chat turn carries the agent\'s system prompt and tools, several thousand tokens, so do not go below ~8192 if you will chat with it.' },
        gpuLayers: { type: 'number', description: 'Layers to offload to the GPU (optional).' },
        ttlSeconds: { type: 'number', description: 'Unload after this many idle seconds; 0 keeps it loaded (optional).' },
      },
      required: ['modelId'],
    },
  },
  {
    name: 'nekko-agent_model_unload',
    description: 'Unload a model from a local runtime to free memory.',
    inputSchema: {
      type: 'object',
      properties: { modelId: { type: 'string' }, providerId: { type: 'string', description: 'Default the built-in engine.' } },
      required: ['modelId'],
    },
  },
  {
    name: 'nekko-agent_runtime_start',
    description: 'Start a local model server (the built-in engine by default, or Ollama/LM Studio via providerId).',
    inputSchema: { type: 'object', properties: { providerId: { type: 'string' } } },
  },
  {
    name: 'nekko-agent_runtime_stop',
    description:
      'Stop a local model server. A server Nekko Agent did not start is refused with needsConfirmation; ask the user before retrying with force: true.',
    inputSchema: { type: 'object', properties: { providerId: { type: 'string' }, force: { type: 'boolean' } } },
  },
  {
    name: 'nekko-agent_status',
    description: 'Summary of this Nekko Agent: providers, default model, workspaces, session count, remote relay status.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(client: Client, name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case 'nekko-agent_chat': {
      let sessionId = args.sessionId as string | undefined;
      if (!sessionId) sessionId = (await client.createSession(args.workspaceId)).id;
      const session = await client.getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      const settings = await client.getSettings();
      const { providerId, modelId } = resolveModel(settings, {
        provider: args.provider,
        model: args.model,
        sessionProvider: session.providerId,
        sessionModel: session.modelId,
      });
      const reply = await runChat(client, {
        sessionId,
        providerId,
        modelId,
        text: String(args.prompt ?? ''),
        approve: approvalPolicy(args.approve),
      });
      return JSON.stringify({ sessionId, provider: providerId, model: modelId, ...reply });
    }
    case 'nekko-agent_list_sessions':
      return JSON.stringify(
        (await client.listSessions()).map((s) => ({ id: s.id, title: s.title, messages: s.messages.length, updatedAt: s.updatedAt })),
        null,
        2,
      );
    case 'nekko-agent_new_session':
      return `Created session ${(await client.createSession(args.workspaceId)).id}`;
    case 'nekko-agent_get_session': {
      const s = await client.getSession(String(args.sessionId));
      if (!s) throw new Error('Session not found');
      return s.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `## ${m.role}\n${m.content}`)
        .join('\n\n');
    }
    case 'nekko-agent_workspace_list':
      return JSON.stringify(await client.listWorkspaces());
    case 'nekko-agent_workspace_add':
      return JSON.stringify(await client.addWorkspaceByPath(String(args.path)));
    case 'nekko-agent_workspace_remove':
      return JSON.stringify(await client.removeWorkspace(String(args.workspaceId)));
    case 'nekko-agent_workspace_index':
      return JSON.stringify(await client.indexWorkspace(String(args.workspaceId)));
    case 'nekko-agent_workspace_search':
      return JSON.stringify(await client.searchWorkspace(String(args.workspaceId), String(args.query)));
    case 'nekko-agent_prompts_list':
      return JSON.stringify((await client.getSettings()).prompts ?? []);
    case 'nekko-agent_tasks_list':
      return JSON.stringify(await client.listTasks());
    case 'nekko-agent_task_create':
      if (
        typeof args.title !== 'string' ||
        typeof args.prompt !== 'string' ||
        !['scheduled', 'recurring', 'background'].includes(args.kind)
      ) {
        throw new Error('Task creation requires title, prompt, and kind (scheduled, recurring, or background).');
      }
      return JSON.stringify(await client.createTask({
        title: args.title,
        prompt: args.prompt,
        kind: args.kind,
        runAt: args.runAt,
        intervalMs: args.intervalMs,
        workspaceId: args.workspaceId,
        providerId: args.providerId,
        modelId: args.modelId,
        condition: args.condition,
        keepAlive: args.keepAlive,
      }));
    case 'nekko-agent_task_run':
      await client.runTaskNow(String(args.taskId));
      return JSON.stringify({ ok: true });
    case 'nekko-agent_task_delete':
      return JSON.stringify(await client.deleteTask(String(args.taskId)));
    case 'nekko-agent_skills_list':
      return JSON.stringify(await client.listInstalledSkills());
    case 'nekko-agent_skill_install': {
      // Same payload resolution as the CLI, so Vaizer skills install by slug.
      const { skillId, payload } = await resolveInstall(client, String(args.skillId));
      return JSON.stringify(
        await client.installSkill(
          skillId,
          normalizeInstallTarget(args.target as string | undefined),
          payload,
        ),
      );
    }
    case 'nekko-agent_tools_list':
      return JSON.stringify(await client.listTools());
    case 'nekko-agent_models_list':
      return JSON.stringify(await client.listModels(String(args.providerId)));
    case 'nekko-agent_train_start': {
      const run = await client.createTrainingRun({
        kind: (args.kind as 'training' | 'goal') ?? 'training',
        name: String(args.name),
        goal: String(args.goal),
        workspaceId: args.workspaceId,
        providerId: args.provider,
        modelId: args.model,
        config: {
          metric: args.metric,
          minimizeMetric: args.minimizeMetric,
          maxExperiments: args.maxExperiments,
          timeBudgetMin: args.timeBudgetMin,
          extra: args.extra,
        },
      });
      if (run.sessionId) await client.setSessionOptions(run.sessionId, { mode: approvalPolicy(args.approve) });
      await client.startTrainingRun(run.id);
      return JSON.stringify({ runId: run.id, sessionId: run.sessionId, status: 'running' }, null, 2);
    }
    case 'nekko-agent_train_status': {
      const runs = await client.listTrainingRuns();
      if (args.runId) {
        const run = runs.find((r) => r.id === args.runId);
        if (!run) throw new Error(`Run ${args.runId} not found`);
        const best = run.experiments.find((e) => e.id === run.bestExperimentId);
        return JSON.stringify(
          {
            id: run.id,
            name: run.name,
            status: run.status,
            turns: run.turns ?? 0,
            best: best ? { id: best.id, title: best.title, score: best.score } : null,
            experiments: run.experiments.map((e) => ({
              id: e.id,
              title: e.title,
              status: e.status,
              score: e.score,
              note: e.note,
            })),
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        runs.map((r) => {
          const best = r.experiments.find((e) => e.id === r.bestExperimentId);
          return { id: r.id, name: r.name, status: r.status, experiments: r.experiments.length, best: best?.score ?? null };
        }),
        null,
        2,
      );
    }
    case 'nekko-agent_train_hint': {
      await client.addTrainingHint(String(args.runId), String(args.text));
      return `Hint queued for ${args.runId}.`;
    }
    case 'nekko-agent_train_stop': {
      await client.stopTrainingRun(String(args.runId));
      return `Run ${args.runId} stopping.`;
    }
    case 'nekko-agent_local_status':
      return JSON.stringify(await localModelStatus(client), null, 2);
    case 'nekko-agent_local_models':
      return JSON.stringify(await listLocalModels(client), null, 2);
    case 'nekko-agent_model_search': {
      const query = typeof args.query === 'string' ? args.query : undefined;
      const hits = await searchCatalog(client, query);
      // An empty page is also what an unreachable Hugging Face looks like, so
      // say so rather than let the caller conclude the model does not exist.
      if (!hits.length) {
        return JSON.stringify({
          results: [],
          note: 'No GGUF repos matched. The Hugging Face search may also be slow or unreachable right now; if you know the exact repo id (owner/repo), pass it to nekko-agent_model_download directly.',
        });
      }
      return JSON.stringify(hits, null, 2);
    }
    case 'nekko-agent_model_download':
      if (typeof args.modelId !== 'string' || !args.modelId) throw new Error('modelId is required.');
      return JSON.stringify(await downloadModel(client, args.modelId, typeof args.quant === 'string' ? args.quant : undefined));
    case 'nekko-agent_downloads': {
      const jobs = (await client.engineDownloads()).map(summarizeDownload);
      const active = ['queued', 'downloading', 'verifying'];
      return JSON.stringify(args.active === true ? jobs.filter((j) => active.includes(j.state)) : jobs, null, 2);
    }
    case 'nekko-agent_download_cancel':
      await client.engineCancelDownload(String(args.jobId));
      return JSON.stringify({ ok: true, jobId: args.jobId });
    case 'nekko-agent_model_load':
      if (typeof args.modelId !== 'string' || !args.modelId) throw new Error('modelId is required.');
      return JSON.stringify(
        await loadModel(client, {
          modelId: args.modelId,
          providerId: args.providerId,
          contextTokens: Number(args.contextTokens) || undefined,
          gpuLayers: typeof args.gpuLayers === 'number' ? args.gpuLayers : undefined,
          ttlSeconds: typeof args.ttlSeconds === 'number' ? args.ttlSeconds : undefined,
        }),
      );
    case 'nekko-agent_model_unload':
      if (typeof args.modelId !== 'string' || !args.modelId) throw new Error('modelId is required.');
      return JSON.stringify(await unloadModel(client, { modelId: args.modelId, providerId: args.providerId }));
    case 'nekko-agent_runtime_start':
      return JSON.stringify(await startRuntime(client, args.providerId));
    case 'nekko-agent_runtime_stop':
      return JSON.stringify(await stopRuntime(client, args.providerId, args.force === true));
    case 'nekko-agent_status': {
      const [s, sessions, remote] = await Promise.all([client.getSettings(), client.listSessions(), client.remoteStatus()]);
      return JSON.stringify(
        {
          providers: s.providers.map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
          defaultModel: s.defaultModelId ?? null,
          workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path })),
          sessions: sessions.length,
          remote,
        },
        null,
        2,
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function runMcpServer(opts: { url?: string; token?: string } = {}): void {
  // Protect the stdout protocol stream: route any stray logs to stderr.
  console.log = (...a: unknown[]) => console.error(...a);
  const client = getClient({ ...opts, longLived: true });
  let buffer = '';

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const err = (id: unknown, message: string) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handle(msg);
    }
  });

  async function handle(msg: any) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
      ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'nekko-agent', title: 'Nekko Agent', version: VERSION } });
    } else if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      /* notifications: no response */
    } else if (method === 'ping') {
      ok(id, {});
    } else if (method === 'tools/list') {
      ok(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const name = params?.name;
        const text = await callTool(client, name, params?.arguments ?? {});
        if (name === 'nekko-agent_chat') {
          const result = JSON.parse(text) as {
            text: string;
            sessionId: string;
            provider: string;
            model: string;
            toolCalls: unknown[];
            blocked: unknown[];
            durationMs: number;
            usage?: unknown;
          };
          const { text: reply, ...metadata } = result;
          ok(id, {
            content: [
              { type: 'text', text: reply },
              { type: 'text', text: JSON.stringify(metadata) },
            ],
          });
        } else {
          ok(id, { content: [{ type: 'text', text }] });
        }
      } catch (e) {
        ok(id, { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    } else if (id !== undefined) {
      err(id, `Unknown method: ${method}`);
    }
  }

  // The client closing stdin (or signalling us) is how an MCP session ends.
  // With an in-process host, models this server loaded run as llama-server
  // children of this process; leave them behind and they hold memory with
  // nobody to unload them. A remote client's engine belongs to the app.
  let ending = false;
  const end = (code: number) => {
    if (ending) return;
    ending = true;
    void stopLocalEngine(client).finally(() => process.exit(code));
  };
  process.stdin.on('end', () => end(0));
  process.once('SIGTERM', () => end(0));
  process.once('SIGINT', () => end(0));
  process.once('SIGHUP', () => end(0));

  console.error('[Nekko Agent] MCP server ready on stdio');
}

/** Stop the model server and the engine if this server started them, bounded so exit never hangs. */
async function stopLocalEngine(client: Client): Promise<void> {
  if (!client.isLocal) return;
  try {
    const status = await Promise.race([client.engineStatus(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    if (!status?.running) return;
    const engine = (await client.getSettings()).providers.find((p) => p.kind === 'llamacpp');
    if (!engine) return;
    await Promise.race([client.runtimeStop(engine.id), new Promise((r) => setTimeout(r, 5000))]);
  } catch {
    /* best effort: exiting anyway */
  } finally {
    await Promise.race([client.close?.(), new Promise((r) => setTimeout(r, 10_000))]);
  }
}
