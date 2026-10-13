import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import type { IndexStatus, MemoryEntry, WorkspaceFolder } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { listDir, readFile, writeFile } from './files.js';
import * as memory from './memory.js';
import * as comments from './comments.js';
import { collectIndexSnippets, getIndexStatus, indexWorkspace, listIndexedFiles, searchWorkspace } from './workspace.js';

/**
 * What the file explorer, memory, comments and workspace index return, which
 * the engine daemon's port (crates/nekko-workspace) must reproduce exactly.
 * Both sides build `golden/tree.json` in a temp folder, run `golden/cases.json`
 * and normalize the same things (the temp paths, save times, random ids,
 * long strings) before comparing with `golden/expected.json`, key order
 * included. Rewrite with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace', 'tests', 'golden');

type Spec = string | { bytes: number[] } | { repeat: string; count: number; head?: string; tail?: string };

function build(base: string, files: Record<string, Spec>): void {
  for (const [rel, spec] of Object.entries(files)) {
    const full = join(base, rel);
    mkdirSync(dirname(full), { recursive: true });
    if (typeof spec === 'string') writeFileSync(full, spec, 'utf8');
    else if ('bytes' in spec) writeFileSync(full, Buffer.from(spec.bytes));
    else writeFileSync(full, (spec.head ?? '') + spec.repeat.repeat(spec.count) + (spec.tail ?? ''), 'utf8');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function norm(v: unknown, root: string, data: string, key?: string): unknown {
  if (typeof v === 'string') {
    let s = v;
    if (key === 'id' && UUID.test(s)) return '<uuid>';
    if (s.startsWith(root)) s = '<root>' + s.slice(root.length);
    else if (s.startsWith(data)) s = '<data>' + s.slice(data.length);
    if (s.startsWith('<root>') || s.startsWith('<data>')) s = s.replace(/\\/g, '/');
    return s.length > 300 ? { length: s.length, head: s.slice(0, 40), tail: s.slice(-40) } : s;
  }
  if (typeof v === 'number' && (key === 'updatedAt' || key === 'createdAt') && v >= 1e12) return 0;
  if (Array.isArray(v)) return v.map((x) => norm(x, root, data));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = norm(x, root, data, k);
    return out;
  }
  return v;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('workspace golden set', () => {
  it('matches what files.ts, memory.ts, comments.ts and workspace.ts return', () => {
    const tree = JSON.parse(readFileSync(join(golden, 'tree.json'), 'utf8')) as {
      root: Record<string, Spec>;
      rootDirs: string[];
      data: Record<string, Spec>;
    };
    const cases = JSON.parse(readFileSync(join(golden, 'cases.json'), 'utf8')) as Array<[string, ...unknown[]]>;
    const root = mkdtempSync(join(tmpdir(), 'nekko-ws-root-'));
    const data = mkdtempSync(join(tmpdir(), 'nekko-ws-data-'));
    dirs.push(root, data);
    build(root, tree.root);
    for (const d of tree.rootDirs) mkdirSync(join(root, d), { recursive: true });
    build(data, tree.data);
    setDataDir(data);

    const folders: Record<string, WorkspaceFolder> = { w1: { id: 'w1', name: 'w1', path: root, addedAt: 0 } };
    const at = (rel: string) => (rel ? join(root, rel) : root);
    const progress: IndexStatus[] = [];
    const run = (name: string, args: unknown[]): unknown => {
      switch (name) {
        case 'read': return readFile(at(args[0] as string));
        case 'list': return listDir(at(args[0] as string));
        case 'write': return writeFile(at(args[0] as string), args[1] as string) ?? null;
        case 'append': appendFileSync(at(args[0] as string), args[1] as string); return null;
        case 'index': {
          progress.length = 0;
          const done = indexWorkspace(folders[args[0] as string], (s) => progress.push({ ...s }));
          return { done, progress: [...progress] };
        }
        case 'files': return listIndexedFiles(args[0] as string);
        case 'status': return getIndexStatus(args[0] as string);
        case 'search': {
          const folder = folders[args[0] as string];
          return folder ? searchWorkspace(folder, args[1] as string) : [];
        }
        case 'snippets': return collectIndexSnippets((args[0] as string[]).map((id) => folders[id]), args[1] as string);
        case 'memList': return memory.listMemory(...(args as [never, never]));
        case 'memSave': {
          const entry = args[0] as MemoryEntry;
          memory.saveMemory(entry);
          return memory.listMemory(entry.scope, entry.workspaceId);
        }
        case 'memFile': return readFileSync(join(data, 'memory', `${args[0] as string}.md`), 'utf8').replace(/updatedAt: \d{13}/g, 'updatedAt: 0');
        case 'memDelete': return memory.deleteMemory(args[0] as string) ?? null;
        case 'cList': return comments.listComments(args[0] as string);
        case 'cAdd': return comments.addComment(...(args as [string, number, string, string]));
        case 'cResolve': {
          const id = comments.listComments(args[0] as string)[args[1] as number]?.id;
          return comments.resolveComment(args[0] as string, id as string);
        }
        case 'cFile':
          return readFileSync(join(data, 'comments.json'), 'utf8')
            .replace(/"id": "[0-9a-f-]{36}"/g, '"id": "<uuid>"')
            .replace(/"createdAt": \d{13}/g, '"createdAt": 0')
            .split('\n');
        default: throw new Error(`unknown op ${name}`);
      }
    };

    const results = cases.map(([name, ...args]) => {
      try {
        return { op: name, result: norm(run(name, args), root, data) };
      } catch (e) {
        return { op: name, error: (e as Error).message };
      }
    });
    const text = `${JSON.stringify(results, null, 2)}\n`;
    const path = join(golden, 'expected.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
