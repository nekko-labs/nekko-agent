import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, consolidate, detectLegacy, legacyEnv, summarize, unmerged, type LegacyEnv } from './legacy-profiles.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const put = (path: string, body: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body)); };
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'nekko-legacy-'));
  dirs.push(root);
  const env: LegacyEnv = legacyEnv({ home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), tmp: join(root, 'tmp'), platform: 'win32', target: join(root, 'home', '.nekko-agent') });
  for (const d of [env.home, env.appData, env.localAppData, env.tmp]) mkdirSync(d, { recursive: true });
  return { root, env };
}

/** The shape found on a real machine: main profile, two AppData profiles, a fresh target. */
function seed(env: LegacyEnv) {
  const main = join(env.home, '.agent-nekko');
  put(join(main, 'sessions', 's_old1.json'), { id: 's_old1', file: join(main, 'sessions', 'x') });
  put(join(main, 'sessions', 's_shared.json'), { id: 's_shared', from: 'main' });
  put(join(main, 'usage.jsonl'), jsonl([{ ts: 1, sessionId: 'a', inputTokens: 5 }, { ts: 3, sessionId: 'a', inputTokens: 7 }]));
  put(join(main, 'settings.json'), { theme: 'old', defaultModelId: 'gpt-6.1-sol', providers: [{ id: 'chatgpt-1' }, { id: 'nekko-engine' }], workspaces: [{ id: 'a', path: join(env.home, 'code', 'kotrain') }], mcpServers: [{ name: 'hypergate' }] });
  put(join(main, 'tokens.json'), { 'chatgpt:1': { accessToken: 'x', obtainedAt: 10 } });
  put(join(main, 'models', '.companions', 'image', 'vae.safetensors'), 'vae');
  put(join(main, 'window-state.json'), { width: 1 });

  const appdata = join(env.appData, '@agent-nekko', 'desktop', 'agent-nekko');
  put(join(appdata, 'sessions', 's_app1.json'), { id: 's_app1' });
  put(join(appdata, 'usage.jsonl'), jsonl([{ ts: 2, sessionId: 'b', inputTokens: 9 }]));
  put(join(appdata, 'models', 'unsloth_Qwen', 'weights.gguf'), 'weights');
  put(join(appdata, 'models', 'library.json'), { models: { 'unsloth_Qwen/w': { id: 'unsloth_Qwen/w', name: 'Qwen', architecture: 'qwen3', file: join(appdata, 'models', 'unsloth_Qwen', 'weights.gguf') } } });
  put(join(env.appData, '@agent-nekko', 'desktop', 'Cache', 'junk'), 'cache');

  const kotrain = join(env.appData, '@kotrain', 'desktop', 'kotrain');
  put(join(kotrain, 'sessions', 's_kot1.json'), { id: 's_kot1' });
  put(join(kotrain, 'usage.jsonl'), jsonl([{ ts: 0, sessionId: 'c', inputTokens: 1 }]));

  put(join(env.localAppData, 'Programs', 'Kotrain', 'Kotrain.exe'), 'exe');
  put(join(env.localAppData, '@kotraindesktop-updater', 'pending', 'x'), 'x');
  put(join(env.tmp, 'kotrain-int-abc', 'x'), 'x');
  put(join(env.tmp, 'unrelated', 'x'), 'x');

  put(join(env.target, 'sessions', 's_new1.json'), { id: 's_new1' });
  put(join(env.target, 'sessions', 's_shared.json'), { id: 's_shared', from: 'target' });
  put(join(env.target, 'usage.jsonl'), jsonl([{ ts: 4, sessionId: 'd', inputTokens: 2 }]));
  put(join(env.target, 'settings.json'), { theme: 'new', providers: [{ id: 'nekko-engine' }, { id: 'anthropic-new' }], workspaces: [{ id: 'w', path: env.home }] });
  return { main, appdata, kotrain };
}

describe('detectLegacy', () => {
  it('finds old data, installs, updater caches and temp leftovers, and ignores everything else', () => {
    const { env } = world(); seed(env);
    const found = detectLegacy(env);
    const kinds = Object.fromEntries(found.map((i) => [i.label, i.kind]));
    expect(kinds['.agent-nekko']).toBe('data');
    expect(kinds['@agent-nekko']).toBe('app-data');
    expect(kinds['@kotrain']).toBe('app-data');
    expect(kinds['Kotrain (installed app)']).toBe('install');
    expect(kinds['@kotraindesktop-updater']).toBe('updater');
    expect(kinds['kotrain-int-abc']).toBe('temp');
    expect(found.some((i) => i.path.endsWith('unrelated'))).toBe(false);
    expect(found.find((i) => i.label === '@agent-nekko')!.dataRoots).toEqual([join(env.appData, '@agent-nekko', 'desktop', 'agent-nekko')]);
  });

  it('reports nothing on a clean machine and never reports the current data folder', () => {
    const { env } = world();
    put(join(env.target, 'settings.json'), {});
    expect(detectLegacy(env)).toEqual([]);
  });

  it('ignores the empty folder Electron recreates on every launch', () => {
    const { env } = world();
    mkdirSync(join(env.appData, 'Nekko Agent', 'GPUCache'), { recursive: true });
    expect(detectLegacy(env)).toEqual([]);
  });
});

describe('summarize', () => {
  it('folds hundreds of temp folders into one row and keeps everything else on its own line', () => {
    const { env } = world(); seed(env);
    for (let i = 0; i < 50; i++) put(join(env.tmp, `kotrain-checkpoint-${i}`, 'x'), 'x');
    const rows = summarize(detectLegacy(env));
    expect(rows.filter((r) => r.kind === 'temp')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'temp')!.count).toBe(51);
    expect(rows.find((r) => r.kind === 'install')!.text).toContain('Kotrain');
    expect(rows.length).toBeLessThan(12);
  });
});

describe('consolidate', () => {
  it('merges sessions, usage, settings, tokens and models without overwriting the target', () => {
    const { env } = world(); const s = seed(env);
    const items = detectLegacy(env);
    const report = consolidate(items, env, { now: 0 });

    expect(existsSync(join(env.target, 'sessions', 's_old1.json'))).toBe(true);
    expect(existsSync(join(env.target, 'sessions', 's_app1.json'))).toBe(true);
    expect(existsSync(join(env.target, 'sessions', 's_kot1.json'))).toBe(true);
    expect(existsSync(join(env.target, 'sessions', 's_new1.json'))).toBe(true);
    expect(json(join(env.target, 'sessions', 's_shared.json')).from).toBe('target');

    const usage = readFileSync(join(env.target, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).ts);
    expect(usage).toEqual([0, 1, 2, 3, 4]);

    const settings = json(join(env.target, 'settings.json'));
    expect(settings.theme).toBe('new');
    expect(settings.defaultModelId).toBe('gpt-6.1-sol');
    expect(settings.providers.map((p: { id: string }) => p.id)).toEqual(['nekko-engine', 'anthropic-new', 'chatgpt-1']);
    expect(settings.mcpServers).toEqual([{ name: 'hypergate' }]);
    expect(settings.workspaces).toHaveLength(2);
    expect(report.deduped?.providers).toEqual({});
    expect(json(join(env.target, 'tokens.json'))['chatgpt:1'].accessToken).toBe('x');

    expect(readFileSync(join(env.target, 'models', '.companions', 'image', 'vae.safetensors'), 'utf8')).toBe('vae');
    const moved = join(env.target, 'models', 'chat', 'unsloth_Qwen', 'weights.gguf');
    expect(readFileSync(moved, 'utf8')).toBe('weights');
    expect(json(join(env.target, 'models', 'library.json')).models['unsloth_Qwen/w'].file).toBe(moved);
    expect(existsSync(join(env.target, 'window-state.json'))).toBe(false);
    expect(report.roots).toHaveLength(3);
    expect(existsSync(join(report.backupDir, 'current', 'settings.json'))).toBe(true);
    expect(existsSync(join(report.backupDir, `source-1-${'.agent-nekko'}`, 'settings.json'))).toBe(true);
    expect(s.main).toBeTruthy();
  });

  it('folds the same folder added by two installs into one and repoints chats', () => {
    const { env } = world(); const s = seed(env);
    const shared = join(env.home, 'code', 'app');
    put(join(s.main, 'settings.json'), { providers: [], workspaces: [{ id: 'old-ws', name: 'app', path: shared }] });
    put(join(s.main, 'sessions', 's_ws.json'), { id: 's_ws', workspaceId: 'old-ws' });
    put(join(env.target, 'settings.json'), { providers: [], workspaces: [{ id: 'new-ws', name: 'app', path: `${shared}\\` }] });
    const report = consolidate(detectLegacy(env), env);
    const settings = json(join(env.target, 'settings.json'));
    expect(settings.workspaces).toHaveLength(1);
    expect(json(join(env.target, 'sessions', 's_ws.json')).workspaceId).toBe(settings.workspaces[0].id);
    expect(Object.keys(report.deduped!.folders)).toHaveLength(1);
  });

  it('rewrites paths that pointed into an old data folder', () => {
    const { env } = world(); seed(env);
    consolidate(detectLegacy(env), env);
    expect(json(join(env.target, 'sessions', 's_old1.json')).file).toBe(join(env.target, 'sessions', 'x'));
  });

  it('is safe to run twice', () => {
    const { env } = world(); seed(env);
    const items = detectLegacy(env);
    consolidate(items, env);
    const before = readFileSync(join(env.target, 'usage.jsonl'), 'utf8');
    const second = consolidate(items, env);
    expect(readFileSync(join(env.target, 'usage.jsonl'), 'utf8')).toBe(before);
    expect(second.roots.every((r) => r.usageRecords === 0)).toBe(true);
  });

  it('refuses while another Nekko process is serving from a profile', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'cli-link.json'), { enabled: true, pid: process.ppid || 1, url: 'x', token: 'y' });
    expect(() => consolidate(detectLegacy(env), env)).toThrow('still running');
    expect(existsSync(join(env.target, 'sessions', 's_old1.json'))).toBe(false);
  });
});

describe('cleanup', () => {
  it('removes merged folders, installs, updater caches and temp leftovers, and nothing else', () => {
    const { env } = world(); seed(env);
    const items = detectLegacy(env);
    consolidate(items, env);
    const uninstalled: string[] = [];
    const report = cleanup(items, env, { uninstall: (i) => { uninstalled.push(i.label); } });
    expect(report.failed).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(existsSync(join(env.home, '.agent-nekko'))).toBe(false);
    expect(existsSync(join(env.appData, '@agent-nekko'))).toBe(false);
    expect(existsSync(join(env.appData, '@kotrain'))).toBe(false);
    expect(existsSync(join(env.localAppData, 'Programs', 'Kotrain'))).toBe(false);
    expect(existsSync(join(env.tmp, 'kotrain-int-abc'))).toBe(false);
    expect(existsSync(join(env.tmp, 'unrelated'))).toBe(true);
    expect(existsSync(env.target)).toBe(true);
    expect(uninstalled).toEqual(['Kotrain (installed app)']);
  });

  it('keeps a folder, with the reason, when it holds something that was not merged', () => {
    const { env } = world(); const s = seed(env);
    const items = detectLegacy(env);
    consolidate(items, env);
    put(join(s.main, 'sessions', 's_late.json'), { id: 's_late' });
    const report = cleanup(items, env, { uninstall: () => {} });
    expect(existsSync(join(env.home, '.agent-nekko', 'sessions', 's_late.json'))).toBe(true);
    expect(report.kept.map((k) => k.path)).toEqual([join(env.home, '.agent-nekko')]);
    expect(report.kept[0].reason).toContain('s_late.json');
    expect(report.removed).toContain(join(env.appData, '@kotrain'));
  });

  it('never deletes anything before it has been merged', () => {
    const { env } = world(); seed(env);
    const report = cleanup(detectLegacy(env), env, { uninstall: () => {} });
    expect(existsSync(join(env.home, '.agent-nekko', 'sessions', 's_old1.json'))).toBe(true);
    expect(report.kept.length).toBeGreaterThanOrEqual(3);
  });

  it('reports unmerged files', () => {
    const { env } = world(); const s = seed(env);
    expect(unmerged(s.main, env.target)).toContain('sessions/s_old1.json');
    expect(unmerged(s.main, env.target)).toContain('usage.jsonl');
  });
});
