import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  it('treats an old engine build as superseded when the target has its own, and never mixes the two', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.appdata, 'engine', 'engine.json'), { buildId: 'win-x64-cuda', version: 'b11003' });
    put(join(s.appdata, 'engine', 'win-x64-cuda', 'ggml-base.dll'), 'old build');
    put(join(s.appdata, 'engine', 'win-x64-cuda', 'llama-old-only.dll'), 'old build');
    put(join(env.target, 'engine', 'engine.json'), { buildId: 'win-x64-cuda', version: 'b11149' });
    put(join(env.target, 'engine', 'win-x64-cuda', 'ggml-base.dll'), 'the newer, larger build');
    const items = detectLegacy(env);
    consolidate(items, env);
    expect(json(join(env.target, 'engine', 'engine.json')).version).toBe('b11149');
    expect(existsSync(join(env.target, 'engine', 'win-x64-cuda', 'llama-old-only.dll'))).toBe(false);
    expect(unmerged(s.appdata, env.target).filter((f) => f.startsWith('engine'))).toEqual([]);
    const report = cleanup(items, env, { uninstall: () => {} });
    expect(report.kept).toEqual([]);
    expect(report.removed).toContain(join(env.appData, '@agent-nekko'));
  });

  it('still moves an old engine into a target that has none', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.appdata, 'engine', 'engine.json'), { binPath: join(s.appdata, 'engine', 'win-x64-cuda', 'llama-server.exe') });
    put(join(s.appdata, 'engine', 'win-x64-cuda', 'llama-server.exe'), 'exe');
    consolidate(detectLegacy(env), env);
    expect(json(join(env.target, 'engine', 'engine.json')).binPath).toBe(join(env.target, 'engine', 'win-x64-cuda', 'llama-server.exe'));
    expect(unmerged(s.appdata, env.target).filter((f) => f.startsWith('engine'))).toEqual([]);
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

describe('CI runners and other data folders', () => {
  /** An old profile with a CI runner, as the desktop app leaves it, and a target with one of its own. */
  function seedRunner(env: LegacyEnv) {
    const s = seed(env);
    const runners = join(s.main, 'runners');
    put(join(runners, 'runners.json'), [
      { id: 'r-old', label: 'nekko-cloud-mac', github: { appId: 1, installationId: 2 }, image: join(runners, 'images', 'custom') },
      { id: 'r-both', label: 'from-source' },
    ]);
    put(join(runners, 'images', 'default', 'disk.img'), 'old image');
    put(join(runners, 'images', 'custom', 'disk.img'), 'custom image');
    put(join(runners, 'images', 'default.new', 'build.json'), { step: 'install' });
    put(join(runners, 'images', 'cache', 'restore.ipsw'), 'download');
    put(join(runners, 'images', 'linux-cache', 'kernel'), 'download');
    put(join(runners, 'images', 'linux.old', 'vmlinux'), 'replaced');
    put(join(runners, 'audit.jsonl'), jsonl([{ ts: 1, event: 'job' }]));
    put(join(runners, 'logs', 'job-1.log'), 'log');
    put(join(runners, 'install-id'), 'oldid000');
    put(join(runners, 'memory.json'), { samples: [1] });
    put(join(runners, 'vms', 'vm-1', 'disk.img'), 'clone');
    put(join(s.main, 'plugins', 'cat', 'manifest.json'), { name: 'cat', root: join(s.main, 'plugins', 'cat') });

    put(join(env.target, 'runners', 'runners.json'), [{ id: 'r-both', label: 'from-target' }]);
    put(join(env.target, 'runners', 'images', 'default', 'disk.img'), 'the image this Mac built');
    put(join(env.target, 'runners', 'install-id'), 'newid000');
    return { ...s, runners };
  }

  it('merges runner records by id, the target winning, with the images they use', () => {
    const { env } = world(); const s = seedRunner(env);
    const report = consolidate(detectLegacy(env), env);
    const records = json(join(env.target, 'runners', 'runners.json')) as Array<{ id: string; label: string; image?: string }>;
    expect(records.map((r) => r.id)).toEqual(['r-both', 'r-old']);
    expect(records[0].label).toBe('from-target');
    expect(records[1].image).toBe(join(env.target, 'runners', 'images', 'custom'));
    expect(readFileSync(join(env.target, 'runners', 'images', 'custom', 'disk.img'), 'utf8')).toBe('custom image');
    expect(readFileSync(join(env.target, 'runners', 'images', 'default', 'disk.img'), 'utf8')).toBe('the image this Mac built');
    expect(readFileSync(join(env.target, 'runners', 'install-id'), 'utf8')).toBe('newid000');
    expect(existsSync(join(env.target, 'runners', 'vms'))).toBe(false);
    for (const local of ['default.new', 'cache', 'linux-cache', 'linux.old']) expect(existsSync(join(env.target, 'runners', 'images', local))).toBe(false);
    expect(existsSync(join(env.target, 'runners', 'logs', 'job-1.log'))).toBe(true);
    expect(readFileSync(join(env.target, 'runners', 'audit.jsonl'), 'utf8')).toContain('"event":"job"');
    expect(report.roots.find((r) => r.source === s.main)?.runners).toBe(1);
    expect(json(join(report.backupDir, 'source-1-.agent-nekko', 'runners', 'runners.json'))).toHaveLength(2);
  });

  it('moves any other known data folder, rewriting paths into it', () => {
    const { env } = world(); seedRunner(env);
    consolidate(detectLegacy(env), env);
    expect(json(join(env.target, 'plugins', 'cat', 'manifest.json')).root).toBe(join(env.target, 'plugins', 'cat'));
  });

  it('reports runner records and data folders the target lacks', () => {
    const { env } = world(); const s = seedRunner(env);
    const left = unmerged(s.main, env.target);
    expect(left).toContain('runners/runners.json');
    expect(left).toContain('runners/images/custom');
    expect(left).toContain('plugins/cat/manifest.json');
    expect(left.filter((f) => /install-id|memory\.json|vms|\.new|\.old|cache/.test(f))).toEqual([]);
  });

  it('keeps an old folder whose runners were not merged, and removes it once they are', () => {
    const { env } = world(); seedRunner(env);
    const items = detectLegacy(env);
    const before = cleanup(items, env, { uninstall: () => {} });
    expect(before.kept.map((k) => k.path)).toContain(join(env.home, '.agent-nekko'));
    expect(existsSync(join(env.home, '.agent-nekko', 'runners', 'runners.json'))).toBe(true);

    consolidate(items, env);
    const after = cleanup(items, env, { uninstall: () => {} });
    expect(after.kept).toEqual([]);
    expect(after.removed).toContain(join(env.home, '.agent-nekko'));
    expect((json(join(env.target, 'runners', 'runners.json')) as unknown[])).toHaveLength(2);
  });

  it('keeps an old folder holding a file that clashes with a different one in the target', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'skills', 'a', 'SKILL.md'), 'old text');
    put(join(env.target, 'skills', 'a', 'SKILL.md'), 'newer, different text');
    const items = detectLegacy(env);
    consolidate(items, env);
    const report = cleanup(items, env, { uninstall: () => {} });
    expect(report.kept.map((k) => k.path)).toEqual([join(env.home, '.agent-nekko')]);
    expect(report.kept[0].reason).toContain('skills/a/SKILL.md');
  });

  it('leaves a moved JSON file byte for byte when it holds no old path', () => {
    const { env } = world(); const s = seed(env);
    // A Latin-1 byte inside a string: still parses, but would not survive a UTF-8 round trip.
    const bytes = Buffer.concat([Buffer.from('{\n\t"name": "caf'), Buffer.from([0xe9]), Buffer.from('",\n\t"version": "1.0"\n}\n')]);
    const file = join(s.main, 'workflow-checkouts', 'repo', 'package.json');
    mkdirSync(join(s.main, 'workflow-checkouts', 'repo'), { recursive: true });
    writeFileSync(file, bytes);
    chmodSync(file, 0o644);

    consolidate(detectLegacy(env), env);
    const moved = join(env.target, 'workflow-checkouts', 'repo', 'package.json');
    expect(readFileSync(moved).equals(bytes)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(moved).mode & 0o777).toBe(0o644);
  });

  it('copies a root JSON file the target lacks byte for byte when it holds no old path', () => {
    const { env } = world(); const s = seed(env);
    const bytes = Buffer.concat([Buffer.from('{"label":"caf'), Buffer.from([0xe9]), Buffer.from('"}')]);
    writeFileSync(join(s.main, 'design.json'), bytes);
    chmodSync(join(s.main, 'design.json'), 0o644);

    consolidate(detectLegacy(env), env);
    expect(readFileSync(join(env.target, 'design.json')).equals(bytes)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(env.target, 'design.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps an old folder until the target holds every key of a runner JSON file', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'runners', 'secrets.json'), { 'github-app-1': 'old key', 'github-app-2': 'other key' });
    put(join(env.target, 'runners', 'secrets.json'), { 'github-app-1': 'target key' });
    expect(unmerged(s.main, env.target)).toContain('runners/secrets.json');

    consolidate(detectLegacy(env), env);
    expect(unmerged(s.main, env.target)).not.toContain('runners/secrets.json');
    expect(json(join(env.target, 'runners', 'secrets.json'))).toEqual({ 'github-app-1': 'target key', 'github-app-2': 'other key' });
  });

  it('does not keep an old folder for a runner VM log that clashes', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'runners', 'logs', 'vm-1.log'), 'old console');
    put(join(s.main, 'runners', 'logs', 'vm-2.log'), 'only here');
    put(join(env.target, 'runners', 'logs', 'vm-1.log'), 'a longer console from this Mac');
    const items = detectLegacy(env);

    const merged = consolidate(items, env);
    expect(readFileSync(join(env.target, 'runners', 'logs', 'vm-2.log'), 'utf8')).toBe('only here');
    expect(merged.roots.flatMap((r) => r.conflicts).filter((c) => c.includes(join('runners', 'logs')))).toEqual([]);
    const report = cleanup(items, env, { uninstall: () => {} });
    expect(report.kept).toEqual([]);
    expect(report.removed).toContain(s.main);
  });
});

describe('what cleanup counts as merged', () => {
  it('keeps an old folder holding a same-length file that differs from the target copy', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'skills', 'a', 'SKILL.md'), 'Use teh tool');
    put(join(env.target, 'skills', 'a', 'SKILL.md'), 'Use the tool');
    const items = detectLegacy(env);

    consolidate(items, env);
    expect(unmerged(s.main, env.target)).toContain('skills/a/SKILL.md');
    const report = cleanup(items, env, { uninstall: () => {} });
    expect(report.kept.map((k) => k.path)).toContain(join(env.home, '.agent-nekko'));
  });

  it('removes an old folder whose clashing file is identical', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'skills', 'a', 'SKILL.md'), 'Use the tool');
    put(join(env.target, 'skills', 'a', 'SKILL.md'), 'Use the tool');
    const items = detectLegacy(env);

    consolidate(items, env);
    expect(unmerged(s.main, env.target)).toEqual([]);
    expect(cleanup(items, env, { uninstall: () => {} }).removed).toContain(join(env.home, '.agent-nekko'));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps an old folder holding a clashing file it cannot read', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'skills', 'a', 'SKILL.md'), 'Use the tool');
    put(join(env.target, 'skills', 'a', 'SKILL.md'), 'Use the tool');
    chmodSync(join(s.main, 'skills', 'a', 'SKILL.md'), 0o000);
    try {
      expect(unmerged(s.main, env.target)).toContain('skills/a/SKILL.md');
    } finally {
      chmodSync(join(s.main, 'skills', 'a', 'SKILL.md'), 0o600);
    }
  });

  it('still compares model downloads by size', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'models', 'chat', 'x.gguf'), 'aaaa');
    put(join(env.target, 'models', 'chat', 'x.gguf'), 'bbbb');
    expect(unmerged(s.main, env.target)).not.toContain('models/chat/x.gguf');
  });

  it('keeps an old folder holding a folder the merge does not know, and names it', () => {
    const { env } = world(); const s = seed(env);
    put(join(s.main, 'notes-v2', 'mine.md'), 'mine');
    const items = detectLegacy(env);

    consolidate(items, env);
    expect(existsSync(join(s.main, 'notes-v2', 'mine.md'))).toBe(true);
    expect(existsSync(join(env.target, 'notes-v2'))).toBe(false);
    expect(unmerged(s.main, env.target)).toEqual(['notes-v2/']);
    const report = cleanup(items, env, { uninstall: () => {} });
    const kept = report.kept.find((k) => k.path === join(env.home, '.agent-nekko'));
    expect(kept?.reason).toContain('notes-v2/');
  });

  it('treats caches and Chromium folders in a data root as disposable', () => {
    const { env } = world();
    const root = join(env.appData, '@open-paw', 'desktop');
    put(join(root, 'settings.json'), { theme: 'old' });
    put(join(root, 'Local State'), '{}');
    for (const dir of ['Crashpad', 'IndexedDB', 'GPUCache', 'DawnGraphiteCache', 'catalog', 'agent-browser']) put(join(root, dir, 'x'), 'x');
    put(join(env.target, 'settings.json'), { theme: 'new' });
    const items = detectLegacy(env);

    consolidate(items, env);
    expect(unmerged(root, env.target)).toEqual([]);
    expect(cleanup(items, env, { uninstall: () => {} }).removed).toContain(join(env.appData, '@open-paw'));
  });

  it('does not report a nested data root against the root that holds it', () => {
    const { env } = world();
    const outer = join(env.home, '.open-paw');
    put(join(outer, 'settings.json'), { theme: 'outer' });
    put(join(outer, 'profile-b', 'sessions', 's_b.json'), { id: 's_b' });
    put(join(env.target, 'settings.json'), { theme: 'new' });
    const items = detectLegacy(env);
    expect(items.find((i) => i.path === outer)?.dataRoots).toEqual([outer, join(outer, 'profile-b')]);

    consolidate(items, env);
    expect(unmerged(outer, env.target, items.find((i) => i.path === outer)!.dataRoots)).toEqual([]);
    expect(cleanup(items, env, { uninstall: () => {} }).removed).toContain(outer);
    expect(existsSync(join(env.target, 'sessions', 's_b.json'))).toBe(true);
  });
});
