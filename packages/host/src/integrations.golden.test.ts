import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectAgentTools, installSubagent, refreshSubagent, subagentSnippet } from './integrations.js';

/**
 * The MCP entries other agent tools hold, which the engine daemon's port
 * (crates/nekko-workspace integrations.rs) must reproduce exactly. Runs the
 * operations in `tests/golden/integrations-cases.json` over a scratch home
 * and writes what detection, installs, refreshes and snippets return, and
 * every config file they leave, to `tests/golden/integrations.json`. The
 * home path is normalized, and so are path separators in messages. Rewrite
 * with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace', 'tests', 'golden');

function norm(v: unknown, home: string, key?: string): unknown {
  if (typeof v === 'string') {
    if (v.includes(home)) return v.split(home).join('<home>').replace(/\\/g, '/');
    return key === 'message' ? v.replace(/\\/g, '/') : v;
  }
  if (Array.isArray(v)) return v.map((x) => norm(x, home));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = norm(x, home, k);
    return out;
  }
  return v;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('integrations golden set', () => {
  it('matches what integrations.ts returns and writes', () => {
    const c = JSON.parse(readFileSync(join(golden, 'integrations-cases.json'), 'utf8'));
    const home = mkdtempSync(join(tmpdir(), 'nekko-integrations-home-'));
    dirs.push(home);
    for (const [rel, text] of Object.entries(c.home as Record<string, string>)) {
      mkdirSync(dirname(join(home, rel)), { recursive: true });
      writeFileSync(join(home, rel), text, 'utf8');
    }
    const run = ([op, ...a]: [string, ...any[]]): unknown => {
      switch (op) {
        case 'detect': return detectAgentTools(home);
        case 'install': return installSubagent(a[0], home, a[1]);
        case 'refresh': return refreshSubagent(a[0], home, a[1]);
        case 'snippet': return subagentSnippet(a[0], a[1]);
        case 'read': return existsSync(join(home, a[0])) ? readFileSync(join(home, a[0]), 'utf8') : null;
        case 'write':
          mkdirSync(dirname(join(home, a[0])), { recursive: true });
          writeFileSync(join(home, a[0]), a[1], 'utf8');
          return null;
        case 'mkdir': mkdirSync(join(home, a[0]), { recursive: true }); return null;
        case 'rm': rmSync(join(home, a[0]), { recursive: true, force: true }); return null;
        case 'ls': return readdirSync(join(home, a[0])).sort();
        default: throw new Error(`unknown op ${op}`);
      }
    };
    const ops = c.ops.map((o: [string, ...unknown[]]) => {
      try {
        return { op: o[0], result: norm(run(o), home) ?? null };
      } catch (e) {
        return { op: o[0], error: (e as Error).message };
      }
    });
    const text = `${JSON.stringify({ ops }, null, 1)}\n`;
    const path = join(golden, 'integrations.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
