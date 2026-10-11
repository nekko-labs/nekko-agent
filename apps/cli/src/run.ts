import { readFileSync } from 'node:fs';
import { stdin } from 'node:process';
import {
  getClient,
  resolveModel,
  runChat,
  approvalPolicy,
  dataDir,
  resolveTarget,
  type ChatOutputEvent,
} from './lib.js';
import { runMcpServer } from './mcp.js';
import { migrateCommand } from './migrate.js';
import { resolveInstall } from './skills.js';
import { VERSION } from './version.js';
import { cliCommand, normalizeInstallTarget, triggerLabel } from '@nekko-agent/shared';
import type { AgentEvent, NewTask } from '@nekko-agent/shared';

export const EXIT_CODES = {
  success: 0,
  usage: 2,
  notConfigured: 3,
  blocked: 4,
  providerFailure: 5,
  timeout: 6,
  unreachable: 7,
} as const;
export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = EXIT_CODES.providerFailure) { super(message); }
}

export function exitCodeForError(message: string): number {
  if (/No provider|No model|not configured/i.test(message)) return EXIT_CODES.notConfigured;
  if (/timed out/i.test(message)) return EXIT_CODES.timeout;
  if (/Cannot reach|HTTP 401|HTTP 403|HTTP 404|fetch failed/i.test(message)) return EXIT_CODES.unreachable;
  return EXIT_CODES.providerFailure;
}

export function parseFlags(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

const HELP = `Nekko Agent CLI (nekko-agent ${VERSION}), drive your local agent from the terminal.

Usage:
  nekko-agent status|sessions|watch [--json]
  nekko-agent chat "<prompt>" [--approve guardrails|yolo|ask] [opts]
  nekko-agent workspace list|add|remove|index|search [opts]
  nekko-agent prompts|tasks|skills|tools|models [opts]
  nekko-agent workflow list|run <name>|trigger <command>|runs [--json]
  nekko-agent train start|status|hint|stop [opts]
  nekko-agent mcp
  nekko-agent migrate [--dry-run] [--yes] [--keep-old]   Merge data from earlier installs
  nekko-agent --help | --version

Install: shipped with the Nekko Agent app, or npm install -g nekko-agent

Target (first one that applies wins):
  --url <http://host:port>       Remote server, with --token <token>
  NEKKO_URL / NEKKO_TOKEN        The same two, from the environment
  the app on this machine        Read from its cli-link.json while it is serving
  the local data directory       No server: this CLI runs the agent itself

chat:
  --session <id> --new --workspace <id> --provider <id> --model <id>
  --file <path>                  Read a multi-line prompt from a file
  --approve <guardrails|yolo|ask> Approval policy (default: guardrails, or NEKKO_APPROVE)
  --json                         One JSON result object
  --stream ndjson                Typed event per line
  --timeout <seconds>            Abort after this many seconds
  --quiet                        Suppress human progress output

Exit codes:
  0 success · 2 usage · 3 nothing configured · 4 guardrail blocked
  5 provider/model failure · 6 timeout · 7 unreachable/unauthorized remote

Local data dir: ${dataDir()} (override with NEKKO_DATA_DIR)`;

const value = (flags: Record<string, string | boolean>, name: string) =>
  typeof flags[name] === 'string' ? flags[name] as string : undefined;
const isMachine = (flags: Record<string, string | boolean>) =>
  flags.json === true || flags.stream === 'ndjson';
const print = (valueToPrint: unknown, json: boolean) =>
  console.log(
    json
      ? JSON.stringify(valueToPrint)
      : typeof valueToPrint === 'object'
        ? JSON.stringify(valueToPrint, null, 2)
        : String(valueToPrint),
  );

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { text += chunk; });
    stdin.on('end', () => resolve(text));
    stdin.on('error', reject);
  });
}

async function promptInput(args: string[], flags: Record<string, string | boolean>): Promise<string> {
  const file = value(flags, 'file');
  if (file) return readFileSync(file, 'utf8');
  if (args[1] === '-' || (!args[1] && !stdin.isTTY)) return readStdin();
  if (args[1]) return args[1];
  throw new CliError('Usage: nekko-agent chat "<prompt>" (or provide --file / stdin)', EXIT_CODES.usage);
}

function taskFrom(flags: Record<string, string | boolean>): NewTask {
  const title = value(flags, 'title');
  const prompt = value(flags, 'prompt');
  const kind = value(flags, 'kind') as NewTask['kind'] | undefined;
  if (!title || !prompt || !kind) {
    throw new CliError(
      'Task creation requires --title, --kind, and --prompt.',
      EXIT_CODES.usage,
    );
  }
  return {
    title,
    prompt,
    kind,
    workspaceId: value(flags, 'workspace'),
    providerId: value(flags, 'provider'),
    modelId: value(flags, 'model'),
    runAt: value(flags, 'run-at') ? Number(value(flags, 'run-at')) : undefined,
    intervalMs: value(flags, 'interval-ms') ? Number(value(flags, 'interval-ms')) : undefined,
    keepAlive: value(flags, 'keep-alive') as NewTask['keepAlive'],
    condition: value(flags, 'condition'),
  };
}

function printEvent(event: ChatOutputEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function mapWatchEvent(event: AgentEvent): ChatOutputEvent | undefined {
  switch (event.type) {
    case 'text':
      return { type: 'text', delta: event.delta };
    case 'tool_call':
      return { type: 'tool_call', call: { name: event.call.name, input: event.call.input } };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolCallId: event.result.toolCallId,
        ok: !event.result.isError,
        output: event.result.output,
      };
    case 'tool_approval_required':
      return {
        type: 'blocked',
        ruleLabels: event.reason ? [event.reason] : [],
        command: typeof event.call.input.command === 'string' ? event.call.input.command : undefined,
        severity: event.severity,
        reason: event.reason,
      };
    case 'done':
      return { type: 'done' };
    case 'error':
      return { type: 'error', message: event.message };
    default:
      return undefined;
  }
}

/** Run one CLI invocation. */
export async function runCli(argv: string[]): Promise<void> {
  const { _, flags } = parseFlags(argv);
  const cmd = _[0];
  if (flags.version || cmd === 'version') return void print(VERSION, !!flags.json);
  if (!cmd || flags.help || cmd === 'help') return void console.log(HELP);
  if (cmd === 'mcp') return runMcpServer({ url: value(flags, 'url'), token: value(flags, 'token') });
  // Before getClient: building a client opens the data root, which refuses to start while an earlier profile is unmerged.
  if (cmd === 'migrate') { process.exitCode = await migrateCommand(flags); return; }
  if (!['status', 'sessions', 'chat', 'watch', 'workspace', 'prompts', 'tasks', 'workflow', 'workflows', 'skills', 'tools', 'models', 'train'].includes(cmd)) throw new CliError(`Unknown command: ${cmd}`, EXIT_CODES.usage);
  const client = getClient({ url: value(flags, 'url'), token: value(flags, 'token') });
  const json = isMachine(flags);
  try {
    if (cmd === 'status') {
      const [s, sessions, remote] = await Promise.all([
        client.getSettings(),
        client.listSessions(),
        client.remoteStatus(),
      ]);
      if (json) {
        return void print({
          providers: s.providers.map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
          defaultModel: s.defaultModelId ?? null,
          workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path })),
          sessions: sessions.length,
          remote,
        }, true);
      }
      const target = resolveTarget({ url: value(flags, 'url'), token: value(flags, 'token') });
      const via =
        target.source === 'app'
          ? ' (the app on this machine)'
          : target.source === 'local'
            ? ' (local data directory, the app is not serving)'
            : '';
      console.log(`Nekko Agent, ${target.url ?? dataDir()}${via}`);
      console.log(`Providers: ${s.providers.map((p) => `${p.label} (${p.id})`).join(', ') || 'none'}`);
      console.log(`Default model: ${s.defaultModelId ?? '-'}`);
      console.log(`Workspaces: ${s.workspaces.map((w) => w.name).join(', ') || 'none'}`);
      console.log(`Sessions: ${sessions.length}`);
      console.log(`Remote relay: ${remote.enabled ? 'enabled' : 'off'}`);
      return;
    }
    if (cmd === 'sessions') {
      const list = await client.listSessions();
      if (json) {
        return void print(
          list.map((s) => ({
            id: s.id,
            title: s.title,
            messages: s.messages.length,
            updatedAt: s.updatedAt,
          })),
          true,
        );
      }
      if (!list.length) return void console.log('No sessions yet.');
      for (const s of list) {
        console.log(
          `${s.id}  ${new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${s.messages.length}msg  ${s.title}`,
        );
      }
      return;
    }
    if (cmd === 'chat') {
      const text = await promptInput(_, flags);
      let sessionId = value(flags, 'session');
      if (!sessionId && !flags.new) sessionId = (await client.listSessions())[0]?.id;
      if (!sessionId) sessionId = (await client.createSession(value(flags, 'workspace'))).id;
      const session = await client.getSession(sessionId);
      if (!session) throw new CliError(`Session ${sessionId} not found`, EXIT_CODES.usage);
      const settings = await client.getSettings();
      const { providerId, modelId } = resolveModel(settings, {
        provider: value(flags, 'provider'),
        model: value(flags, 'model'),
        sessionProvider: session.providerId,
        sessionModel: session.modelId,
      });
      const policy = approvalPolicy(value(flags, 'approve'));
      if (!flags.quiet && !json) {
        process.stderr.write(`· session ${sessionId} · ${modelId} · approve=${policy}\n`);
      }
      const result = await runChat(client, {
        sessionId,
        providerId,
        modelId,
        text,
        approve: policy,
        timeoutMs: value(flags, 'timeout') ? Number(value(flags, 'timeout')) * 1000 : undefined,
        onText: (t) => {
          if (!json) process.stdout.write(t);
        },
        onEvent: flags.stream === 'ndjson' ? printEvent : undefined,
      });
      if (json && flags.stream !== 'ndjson') {
        print({ sessionId, provider: providerId, model: modelId, ...result }, true);
      } else if (!json) {
        process.stdout.write('\n');
      }
      if (result.blocked.length) {
        throw new CliError(
          `Guardrails blocked ${result.blocked.length} tool call(s). Use --approve yolo to override.`,
          EXIT_CODES.blocked,
        );
      }
      return;
    }
    if (cmd === 'watch') {
      await client.ready();
      if (!flags.quiet && !json) {
        process.stderr.write('Watching agent events… (Ctrl+C to stop)\n');
      }
      const off = client.onAgentEvent((e: AgentEvent) => {
        if (value(flags, 'session') && e.sessionId !== value(flags, 'session')) return;
        if (json) {
          const mapped = mapWatchEvent(e);
          if (mapped) printEvent(mapped);
        } else if (e.type === 'text') {
          process.stdout.write(e.delta);
        } else {
          process.stdout.write(`\n[${e.sessionId.slice(0, 8)}] ${e.type}\n`);
        }
      });
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off('SIGINT', stop);
          off();
          resolve();
        };
        process.once('SIGINT', stop);
      });
      return;
    }
    if (cmd === 'workspace') {
      const sub = _[1];
      if (sub === 'list') return void print(await client.listWorkspaces(), json);
      if (sub === 'add') {
        return void print(await client.addWorkspaceByPath(value(flags, 'path') ?? _[2] ?? ''), json);
      }
      if (sub === 'remove') {
        return void print(await client.removeWorkspace(value(flags, 'id') ?? _[2] ?? ''), json);
      }
      if (sub === 'index') {
        return void print(await client.indexWorkspace(value(flags, 'id') ?? _[2] ?? ''), json);
      }
      if (sub === 'search') {
        return void print(
          await client.searchWorkspace(
            value(flags, 'id') ?? _[2] ?? '',
            value(flags, 'query') ?? _[3] ?? '',
          ),
          json,
        );
      }
      throw new CliError('Usage: nekko-agent workspace list|add|remove|index|search', EXIT_CODES.usage);
    }
    if (cmd === 'prompts') return void print((await client.getSettings()).prompts ?? [], json);
    if (cmd === 'tasks') {
      const sub = _[1];
      if (sub === 'list') return void print(await client.listTasks(), json);
      if (sub === 'add' || sub === 'create') return void print(await client.createTask(taskFrom(flags)), json);
      if (sub === 'run') {
        await client.runTaskNow(value(flags, 'id') ?? _[2] ?? '');
        return void print({ ok: true }, json);
      }
      if (sub === 'delete') {
        return void print(await client.deleteTask(value(flags, 'id') ?? _[2] ?? ''), json);
      }
      throw new CliError('Usage: nekko-agent tasks list|add|run|delete', EXIT_CODES.usage);
    }
    if (cmd === 'workflow' || cmd === 'workflows') {
      const sub = _[1] ?? 'list';
      if (sub === 'list') {
        const { workflows } = await client.listWorkflows();
        return void print(
          json
            ? workflows
            : workflows.map((w) => ({
                name: w.name,
                command: cliCommand(w),
                category: w.category,
                enabled: w.enabled,
                steps: w.steps.length,
                triggers: w.triggers.map((t) => triggerLabel(t, w)).join('; '),
                last: w.lastStatus ?? '-',
              })),
          json,
        );
      }
      if (sub === 'runs') {
        const { runs } = await client.listWorkflows();
        return void print(runs, json);
      }
      if (sub === 'run' || sub === 'trigger') {
        // Named by CLI command (what a `cli` trigger answers to), by exact name,
        // or by id, so a script doesn't have to know a uuid.
        const target = value(flags, 'name') ?? _[2] ?? '';
        if (!target) throw new CliError('Usage: nekko-agent workflow run <name>', EXIT_CODES.usage);
        // `run` fires the named workflow directly; `trigger` offers the name as a
        // CLI event, so every workflow with a matching cli trigger reacts.
        if (sub === 'trigger') {
          const started = await client.dispatchWorkflowEvent({ kind: 'cli', command: target });
          if (started.length === 0) {
            throw new CliError(`No enabled workflow listens for the CLI command "${target}".`, EXIT_CODES.usage);
          }
          return void print(json ? started : started.map((r) => ({ run: r.id, status: r.status, message: r.message })), json);
        }
        const { workflows } = await client.listWorkflows();
        const wf = workflows.find(
          (w) => w.id === target || w.name === target || cliCommand(w) === target.toLowerCase(),
        );
        if (!wf) throw new CliError(`No workflow matches "${target}".`, EXIT_CODES.usage);
        const run = await client.runWorkflow(wf.id);
        if (!run) throw new CliError(`"${wf.name}" did not start (already running, or it has no steps).`, EXIT_CODES.usage);
        if (run.status !== 'success') {
          throw new CliError(`"${wf.name}" ${run.status}${run.message ? `: ${run.message}` : ''}`, EXIT_CODES.providerFailure);
        }
        return void print(json ? run : { workflow: wf.name, status: run.status, steps: run.steps.length }, json);
      }
      throw new CliError('Usage: nekko-agent workflow list|run <name>|trigger <command>|runs', EXIT_CODES.usage);
    }
    if (cmd === 'skills') {
      if (_[1] === 'install') {
        const id = value(flags, 'id') ?? _[2];
        if (!id) {
          throw new CliError(
            'Usage: nekko-agent skills install <id> [--target nekko-agent|claude|codex]',
            EXIT_CODES.usage,
          );
        }
        // Vaizer skills only install with a payload snapshot; resolve it here
        // so the slug vaizer.app publishes (`nyaa`) works, not just built-ins.
        const { skillId, payload } = await resolveInstall(client, id);
        return void print(
          await client.installSkill(
            skillId,
            normalizeInstallTarget(value(flags, 'target')),
            payload,
          ),
          json,
        );
      }
      return void print(await client.listInstalledSkills(), json);
    }
    if (cmd === 'tools') return void print(await client.listTools(), json);
    if (cmd === 'models') {
      const settings = await client.getSettings();
      const provider = value(flags, 'provider') ?? _[1] ?? settings.defaultProviderId ?? settings.providers[0]?.id;
      if (!provider) throw new CliError('No provider configured.', EXIT_CODES.notConfigured);
      return void print(await client.listModels(provider), json);
    }
    if (cmd === 'train') {
      const sub = _[1];
      if (sub === 'status') return void print(await client.listTrainingRuns(), json);
      if (sub === 'hint') {
        await client.addTrainingHint(value(flags, 'id') ?? _[2] ?? '', value(flags, 'text') ?? _[3] ?? '');
        return void print({ ok: true }, json);
      }
      if (sub === 'stop') {
        await client.stopTrainingRun(value(flags, 'id') ?? _[2] ?? '');
        return void print({ ok: true }, json);
      }
      if (sub === 'start') {
        const settings = await client.getSettings();
        const { providerId, modelId } = resolveModel(settings, {
          provider: value(flags, 'provider'),
          model: value(flags, 'model'),
        });
        const run = await client.createTrainingRun({
          kind: (value(flags, 'kind') as 'training' | 'goal') ?? 'training',
          name: value(flags, 'name') ?? _[2] ?? '',
          goal: value(flags, 'goal') ?? _[3] ?? '',
          workspaceId: value(flags, 'workspace'),
          providerId,
          modelId,
          config: {
            metric: value(flags, 'metric'),
            extra: value(flags, 'extra'),
            maxExperiments: Number(value(flags, 'max-experiments')) || undefined,
          },
        });
        await client.startTrainingRun(run.id);
        return void print({ runId: run.id, sessionId: run.sessionId, status: 'running' }, json);
      }
      throw new CliError('Usage: nekko-agent train start|status|hint|stop', EXIT_CODES.usage);
    }
    throw new CliError(`Unknown command: ${cmd}`, EXIT_CODES.usage);
  } catch (e) {
    if (e instanceof CliError) throw e;
    const message = (e as Error).message;
    throw new CliError(message, exitCodeForError(message));
  }
}
