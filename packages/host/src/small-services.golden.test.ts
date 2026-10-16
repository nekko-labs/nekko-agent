import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelInfo, VaizerCatalog } from '@nekko-agent/shared';
import { withDataDir } from './paths.js';
import { AgentWatchService } from './agent-watches.js';
import { startUpdateChecks } from './update-checks.js';
import { clearSessions } from './sessions.js';
import { clearMemory } from './memory.js';
import { clearUsage } from './usage.js';
import { defaultSettings, resetSettings } from './store.js';
import { flushAgentLogs } from './agent-log.js';

/**
 * The small services the engine daemon took over (PF14 A4), held to the TS
 * functions by one golden set the Rust ports match as text
 * (crates/nekkod/tests/golden/small-services.json): `session:watches` (the
 * watch views over a real `agent-watches.json`), `data:wipe` (what the TS
 * wipe leaves of a fixture data directory, file by file), and `updates:check`
 * (the update-check service driven through scripted model lists and skill
 * catalogs, every event it emits after each step). Fails when stale; rewrite
 * with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekkod', 'tests', 'golden', 'small-services.json');

function check(actual: unknown): void {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, text);
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(text));
}

const watch = (patch: Record<string, unknown>) => ({
  id: 'w1',
  sessionId: 's1',
  kind: 'timer',
  prompt: 'secret continuation',
  nextPollAt: 1000,
  intervalMs: 60000,
  deadlineAt: 2000,
  status: 'active',
  failures: 0,
  ...patch,
});

/** `agent-watches.json` contents and the session to list them for. */
const WATCH_CASES: Array<{ name: string; file: string | null; sessionId: string }> = [
  { name: 'no file', file: null, sessionId: 's1' },
  { name: 'corrupt file', file: '{not json', sessionId: 's1' },
  { name: 'not a list', file: '{"w":1}', sessionId: 's1' },
  {
    name: 'every field, prompts left out, newest last',
    file: JSON.stringify([
      watch({}),
      watch({ id: 'w2', kind: 'pr', url: 'https://github.com/o/r/pull/1', status: 'done', fingerprint: 'abc', pending: 'PR changed', failures: 2, lastError: 'x'.repeat(320) }),
      watch({ id: 'w3', sessionId: 's2' }),
      watch({ id: 'w4', url: '', lastError: '', pending: '' }),
      // An emoji that ends exactly at the 300-unit cut. (One that straddles it
      // would leave JavaScript half a surrogate pair, which no JSON parser
      // takes back; the Rust cut stops before the pair, as nekko-js does.)
      watch({ id: 'w5', failures: undefined, status: 'error', lastError: `${'é'.repeat(298)}😀tail` }),
    ]),
    sessionId: 's1',
  },
  { name: 'another chat', file: JSON.stringify([watch({}), watch({ id: 'w3', sessionId: 's2' })]), sessionId: 's2' },
  { name: 'odd values pass through', file: JSON.stringify([watch({ failures: null, deadlineAt: 1.5, nextPollAt: null, url: null, extra: true })]), sessionId: 's1' },
];

function watchViews() {
  return WATCH_CASES.map((c) => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-watch-golden-'));
    try {
      if (c.file !== null) writeFileSync(join(dir, 'agent-watches.json'), c.file);
      const service = new AgentWatchService(() => join(dir, 'agent-watches.json'), {
        busy: () => false,
        exists: () => true,
        snapshot: async () => '',
        resume: async () => {},
      });
      // listAgentWatchViews: views, and [] when the file cannot be read.
      let views: unknown;
      try {
        views = service.views(c.sessionId);
      } catch {
        views = [];
      }
      return { ...c, views: JSON.parse(JSON.stringify(views)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** Every file under `dir`, as `path: contents` (folders as `path/`). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p).split('\\').join('/');
      if (statSync(p).isDirectory()) {
        out[`${rel}/`] = '';
        walk(p);
      } else out[rel] = rel === 'settings.json' ? '<settings>' : readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** Fixture data directories, as `path: contents`. */
const WIPE_CASES: Array<{ name: string; files: Record<string, string> }> = [
  { name: 'an empty data directory', files: {} },
  {
    name: 'a used data directory',
    files: {
      'settings.json': '{"theme":"dark","providers":[{"id":"p"}]}',
      'sessions/s_a.json': JSON.stringify({ id: 's_a', title: 'A', messages: [], createdAt: 1, updatedAt: 1 }),
      'sessions/s_b.json': JSON.stringify({ id: 's_b', title: 'B', messages: [], createdAt: 1, updatedAt: 2 }),
      'sessions/s_a.commands.log': 'ran ls\n',
      'sessions/broken.json': '{nope',
      'sessions/notes.txt': 'kept',
      'memory/m1.md': '---\nscope: global\n---\nnote',
      'memory/m2.md': 'note two',
      'memory/readme.txt': 'kept',
      'usage.jsonl': '{"tokens":1}\n',
      'replies.jsonl': '{"ms":1}\n',
      'tokens.json': '{"secret":true}',
      'tasks.json': '[]',
      'agent-watches.json': '[]',
      'remote.json': '{}',
      'workflows.json': '[]',
    },
  },
  { name: 'only usage', files: { 'usage.jsonl': 'x\n' } },
];

async function wipes() {
  const out = [];
  for (const c of WIPE_CASES) {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-wipe-golden-'));
    try {
      for (const [p, text] of Object.entries(c.files)) {
        mkdirSync(join(dir, p, '..'), { recursive: true });
        writeFileSync(join(dir, p), text);
      }
      const settings = await withDataDir(dir, async () => {
        // host.wipeAllData, without the in-memory limit cache and the phone's appearance event.
        clearSessions('all');
        clearMemory();
        clearUsage();
        const next = resetSettings();
        // The chats' command logs go on the host's log queue.
        await flushAgentLogs();
        return next;
      });
      out.push({ ...c, after: tree(dir), settingsReset: existsSync(join(dir, 'settings.json')), returnsDefaults: JSON.stringify(settings) === JSON.stringify(defaultSettings()) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

const settings = (patch: Partial<AppSettings> = {}) =>
  ({
    providers: [
      { id: 'cg', kind: 'chatgpt', label: 'ChatGPT', baseUrl: 'https://chatgpt.com/backend-api', enabled: true },
      { id: 'off', kind: 'openai', label: 'Off', baseUrl: 'https://api.openai.com/v1', enabled: false },
      { id: 'lm', kind: 'lmstudio', label: 'LM', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
    ],
    ...patch,
  }) as AppSettings;

const model = (id: string): ModelInfo => ({ id, providerId: 'p', name: id });
const catalog = (ids: string[]): VaizerCatalog => ({
  marketplace: 'vaizer',
  skills: ids.map((id) => ({ id, name: id, slug: id, category: 'c', description: id, tier: 'community' as const, author: 'a' })),
  source: 'live',
});

/**
 * One update-check script: each step sets what the providers and the skills
 * catalog answer (`null` fails the call), then runs a manual check or a
 * scheduled tick; the events emitted by that step are recorded.
 */
interface UpdateStep {
  run: 'now' | 'tick';
  settings?: Partial<AppSettings>;
  models?: Record<string, string[] | null>;
  skills?: string[] | null;
}

const UPDATE_SCRIPTS: Array<{ name: string; steps: UpdateStep[] }> = [
  {
    name: 'seeds silently, then a new model and a removed one',
    steps: [
      { run: 'now', models: { cg: ['a', 'b'], lm: ['x'] }, skills: ['s1'] },
      { run: 'now', models: { cg: ['b', 'a'], lm: ['x'] }, skills: ['s1'] },
      { run: 'now', models: { cg: ['a', 'b', 'c'], lm: [] }, skills: ['s1'] },
      { run: 'now', models: { cg: ['a', 'b', 'c'], lm: ['x', 'y'] }, skills: ['s1'] },
      { run: 'now', models: { cg: ['a'], lm: null }, skills: ['s1', 's2'] },
    ],
  },
  {
    name: 'scheduled ticks follow the toggles',
    steps: [
      { run: 'tick', models: { cg: ['a'], lm: ['x'] }, skills: ['s1'] },
      { run: 'tick', models: { cg: ['a', 'b'], lm: ['x'] }, skills: ['s2'] },
      { run: 'tick', settings: { updates: { modelLists: false, skills: true } }, models: { cg: ['a'], lm: ['x'] }, skills: ['s2'] },
      { run: 'tick', settings: { updates: { modelLists: false, skills: true } }, models: { cg: ['a'] }, skills: ['s3'] },
      { run: 'tick', settings: { updates: { modelLists: true } }, models: { cg: ['a', 'z'], lm: ['x'] }, skills: ['s9'] },
      { run: 'now', settings: { updates: { modelLists: false, skills: false } }, models: { cg: ['a', 'z', 'q'], lm: ['x'] }, skills: ['s3', 's4'] },
    ],
  },
  {
    name: 'a failing skills catalog and duplicate ids',
    steps: [
      { run: 'now', models: { cg: ['a', 'a'] }, skills: null },
      { run: 'now', models: { cg: ['a'] }, skills: ['s1', 's1'] },
      { run: 'now', models: { cg: ['a', 'a'] }, skills: ['s1'] },
      { run: 'now', models: { cg: null }, skills: null },
      { run: 'now', models: { cg: ['a'] }, skills: [] },
      { run: 'now', models: { cg: ['a'] }, skills: [] },
    ],
  },
  {
    name: 'a provider turned off and on again',
    steps: [
      { run: 'now', models: { cg: ['a'], lm: ['x'] } },
      {
        run: 'now',
        settings: { providers: settings().providers.map((p) => (p.id === 'lm' ? { ...p, enabled: false } : p)) },
        models: { cg: ['a'], lm: ['y'] },
      },
      { run: 'now', models: { cg: ['a'], lm: ['y'] } },
    ],
  },
];

async function updateScripts() {
  const out = [];
  for (const script of UPDATE_SCRIPTS) {
    let step: UpdateStep = { run: 'now' };
    const emitted: unknown[] = [];
    const listed: string[] = [];
    const svc = startUpdateChecks({
      settings: () => settings(step.settings),
      listModels: async (id) => {
        listed.push(id);
        const ids = step.models?.[id];
        if (ids === null) throw new Error('down');
        return (ids ?? []).map(model);
      },
      emit: (channel, payload) => emitted.push({ channel, payload: JSON.parse(JSON.stringify(payload)) }),
      fetchSkillsCatalog: async () => {
        if (step.skills === null) throw new Error('offline');
        return catalog(step.skills ?? []);
      },
      intervalMs: 60_000_000,
      startDelayMs: 60_000_000,
    });
    const steps = [];
    for (const s of script.steps) {
      step = s;
      emitted.length = 0;
      listed.length = 0;
      // A manual check (`runNow`) or what the timer runs (`tickScheduled`).
      await (s.run === 'now' ? svc.runNow() : svc.tickScheduled());
      steps.push({ ...s, listed: [...listed], emitted: [...emitted] });
    }
    svc.stop();
    out.push({ name: script.name, steps });
  }
  return out;
}

describe('small services golden set', () => {
  it('matches what the TS functions return and leave', async () => {
    check({ watchViews: watchViews(), wipes: await wipes(), updateChecks: await updateScripts() });
  });
});
