import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lib from './lib.js';
import * as skills from './skills.js';
import { runMcpServer } from './mcp.js';

const toolCases = [
  ['chat', 'getSession', { sessionId: 'session', prompt: 'hello' }],
  ['list_sessions', 'listSessions', {}],
  ['new_session', 'createSession', {}],
  ['get_session', 'getSession', { sessionId: 'session' }],
  ['workspace_list', 'listWorkspaces', {}],
  ['workspace_add', 'addWorkspaceByPath', { path: '/workspace' }],
  ['workspace_remove', 'removeWorkspace', { workspaceId: 'workspace' }],
  ['workspace_index', 'indexWorkspace', { workspaceId: 'workspace' }],
  ['workspace_search', 'searchWorkspace', { workspaceId: 'workspace', query: 'hello' }],
  ['prompts_list', 'getSettings', {}],
  ['tasks_list', 'listTasks', {}],
  ['task_create', 'createTask', { title: 'task', prompt: 'hello', kind: 'scheduled' }],
  ['task_run', 'runTaskNow', { taskId: 'task' }],
  ['task_delete', 'deleteTask', { taskId: 'task' }],
  ['skills_list', 'listInstalledSkills', {}],
  ['skill_install', 'installSkill', { skillId: 'skill' }],
  ['tools_list', 'listTools', {}],
  ['models_list', 'listModels', { providerId: 'provider' }],
  ['train_start', 'createTrainingRun', { name: 'run', goal: 'hello' }],
  ['train_status', 'listTrainingRuns', {}],
  ['train_hint', 'addTrainingHint', { runId: 'run', text: 'hello' }],
  ['train_stop', 'stopTrainingRun', { runId: 'run' }],
  ['local_status', 'engineStatus', {}],
  ['local_models', 'engineModels', {}],
  ['model_search', 'engineCatalog', { query: 'qwen' }],
  ['model_download', 'engineDownloadModel', { modelId: 'unsloth/Qwen3-4B-GGUF' }],
  ['downloads', 'engineDownloads', {}],
  ['download_cancel', 'engineCancelDownload', { jobId: 'job' }],
  ['model_load', 'runtimeLoad', { modelId: 'qwen3-4b' }],
  ['model_unload', 'unloadModel', { modelId: 'qwen3-4b' }],
  ['runtime_start', 'runtimeStart', {}],
  ['runtime_stop', 'runtimeStop', {}],
  ['status', 'remoteStatus', {}],
] as const;

vi.mock('./lib.js', async (importOriginal) => ({ ...await importOriginal<typeof lib>() }));
vi.mock('./skills.js', async (importOriginal) => ({ ...await importOriginal<typeof skills>() }));

describe('MCP tool identity and legacy dispatch', () => {
  let receive: (chunk: string) => void;
  let messages: any[];
  let client: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    messages = [];
    client = Object.fromEntries(toolCases.map(([, method]) => [method, vi.fn().mockResolvedValue([])]));
    client.getSettings.mockResolvedValue({
      providers: [{ id: 'nekko-engine', kind: 'llamacpp', label: 'Engine', baseUrl: 'http://127.0.0.1:1/v1', enabled: true }],
      workspaces: [],
      prompts: [],
    });
    client.engineStatus.mockResolvedValue({ install: { binPath: '/bin/llama-server' }, running: false, resident: [], log: [], port: 1, settings: {} });
    client.engineCatalogModel = vi.fn().mockResolvedValue({ id: 'unsloth/Qwen3-4B-GGUF', name: 'Qwen3 4B', owner: 'unsloth', tags: [], quants: [{ label: 'Q8_0', file: 'a' }, { label: 'Q4_K_M', file: 'b', sizeBytes: 2.5 * 1024 ** 3 }] });
    client.engineDownloadModel.mockResolvedValue({ ok: true, message: 'Downloading', jobId: 'job' });
    client.runtimeLoad.mockResolvedValue({ ok: true });
    client.unloadModel.mockResolvedValue({ ok: true });
    client.runtimeStart.mockResolvedValue({ kind: 'llamacpp', running: true, owned: true, baseUrl: 'http://127.0.0.1:1/v1', resident: [] });
    client.runtimeStop.mockResolvedValue({ ok: true, message: 'Stopped' });
    client.runtimeStatus = vi.fn().mockResolvedValue(null);
    client.getSession.mockResolvedValue({ id: 'session', messages: [] });
    client.createSession.mockResolvedValue({ id: 'session' });
    client.createTrainingRun.mockResolvedValue({ id: 'run', sessionId: 'session' });
    client.remoteStatus.mockResolvedValue({ enabled: false });
    client.setSessionOptions = vi.fn().mockResolvedValue(undefined);
    client.startTrainingRun = vi.fn().mockResolvedValue([]);
    vi.spyOn(lib, 'getClient').mockReturnValue(client as unknown as lib.Client);
    vi.spyOn(lib, 'resolveModel').mockReturnValue({ providerId: 'provider', modelId: 'model' });
    vi.spyOn(lib, 'runChat').mockResolvedValue({ text: 'reply', toolCalls: [], blocked: [], durationMs: 1 });
    vi.spyOn(skills, 'resolveInstall').mockResolvedValue({ skillId: 'skill' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener) => {
      if (event === 'data') receive = listener;
      return process.stdin;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      messages.push(JSON.parse(String(chunk)));
      return true;
    });
    runMcpServer();
  });

  afterEach(() => vi.restoreAllMocks());

  it('advertises only canonical tools and skill targets', () => {
    receive(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');
    expect(messages[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      toolCases.map(([suffix]) => `nekko-agent_${suffix}`),
    );
    const install = messages[0].result.tools.find((tool: { name: string }) => tool.name === 'nekko-agent_skill_install');
    expect(install.inputSchema.properties.target.enum).toEqual([
      'nekko-agent', 'claude', 'codex',
    ]);
  });

  describe.each(['nekko-agent'])('%s tools', (prefix) => {
    it.each(toolCases)('dispatches %s through %s', async (suffix, method, args) => {
      receive(JSON.stringify({ id: 1, method: 'tools/call', params: { name: `${prefix}_${suffix}`, arguments: args } }) + '\n');
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0].result.isError).toBeUndefined();
      expect(client[method]).toHaveBeenCalledOnce();
      if (suffix === 'chat') {
        expect(messages[0].result.content).toEqual([
          { type: 'text', text: 'reply' },
          { type: 'text', text: JSON.stringify({ sessionId: 'session', provider: 'provider', model: 'model', toolCalls: [], blocked: [], durationMs: 1 }) },
        ]);
      }
      if (suffix === 'model_download') {
        expect(client.engineDownloadModel).toHaveBeenCalledWith('unsloth/Qwen3-4B-GGUF', 'Q4_K_M');
      }
      if (suffix === 'model_load') {
        expect(client.runtimeLoad).toHaveBeenCalledWith('nekko-engine', 'qwen3-4b', {});
      }
      if (suffix === 'skill_install') {
        expect(client.installSkill).toHaveBeenCalledWith('skill', 'nekko-agent', undefined);
      }
    });
  });

  it.each(['nekko-agent_missing', 'other_status'])('rejects unknown tool %s', async (name) => {
    receive(JSON.stringify({ id: 1, method: 'tools/call', params: { name } }) + '\n');
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].result).toMatchObject({ isError: true, content: [{ text: `Error: Unknown tool: ${name}` }] });
  });
});

describe('MCP stdio transport', () => {
  it('negotiates and lists tools with JSON-only stdout', async () => {
    const binary = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    if (!existsSync(binary)) {
      throw new Error(`Build the CLI before running this integration test: ${binary}`);
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'nekko-mcp-test-'));
    const child = spawn(process.execPath, [binary, 'mcp'], {
      env: { ...process.env, NEKKO_URL: '', NEKKO_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let buffer = '';
    let timeout: ReturnType<typeof setTimeout>;
    const response = new Promise<void>((resolveResponse, reject) => {
      timeout = setTimeout(() => reject(new Error('MCP stdio response timeout')), 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          lines.push(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
        if (lines.length >= 3) {
          clearTimeout(timeout);
          resolveResponse();
        }
      });
      child.on('error', reject);
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1' },
      },
    })}\n`);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nekko-agent_status","arguments":{}}}\n');

    try {
      await response;
      const messages = new Map(lines.map((line) => { const message = JSON.parse(line); return [message.id, message]; }));
      expect(messages.get(1).result.protocolVersion).toBe('2025-06-18');
      expect(messages.get(1).result.serverInfo).toMatchObject({ name: 'nekko-agent', title: 'Nekko Agent' });
      expect(messages.get(2).result.tools.map((tool: { name: string }) => tool.name)).toEqual(
        toolCases.map(([suffix]) => `nekko-agent_${suffix}`),
      );
      expect(messages.get(3).result.isError).toBeUndefined();
      expect(messages.get(3).result.content[0].text).toContain('"providers"');
    } finally {
      clearTimeout(timeout!);
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill();
      await closed;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
