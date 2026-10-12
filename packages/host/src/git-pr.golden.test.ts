import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { collectSessionPrUrls, parsePrUrl } from '@nekko-agent/shared';
import { parsePorcelainV2, parseWorktree } from './git.js';
import { checksFromStatus, diffFileFromApi, parseUnifiedDiff, prInfoFromApi, prInfoFromGh, rollupChecks } from './pr.js';
import { githubReadCooldownMs } from './pr-cache.js';

/**
 * The pure halves of git.ts and pr.ts, which the engine daemon's port
 * (crates/nekko-workspace git.rs and pr.rs) must reproduce exactly: the
 * porcelain and worktree parsers, the PR shapes from gh and the REST API,
 * the diff splitter, and which transcript lines attach a PR. Rewrite with
 * UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace', 'tests', 'golden');

describe('git and PR golden set', () => {
  it('matches what git.ts and pr.ts compute', () => {
    const c = JSON.parse(readFileSync(join(golden, 'git-pr-cases.json'), 'utf8'));
    const stamp = <T extends { updatedAt: number }>(s: T) => ({ ...s, updatedAt: 0 });
    const actual = {
      porcelain: c.porcelain.map((s: string) => stamp(parsePorcelainV2('w', s))),
      worktree: c.worktree.map(([out, cwd]: [string, string]) => parseWorktree(out, cwd) ?? null),
      rollup: c.rollup.map((r: unknown) => rollupChecks(r)),
      ghInfo: c.ghInfo.map(([url, j, lifecycle]: [string, Record<string, unknown>, boolean]) => prInfoFromGh(url, parsePrUrl(url)!, j, lifecycle)),
      apiInfo: c.apiInfo.map(([url, j, checks]: [string, Record<string, unknown>, never]) => prInfoFromApi(url, parsePrUrl(url)!, j, checks)),
      checks: c.checks.map((cj: never) => checksFromStatus(cj)),
      diffs: c.diffs.map((d: string) => parseUnifiedDiff(d)),
      apiFiles: c.apiFiles.map((f: Record<string, unknown>) => diffFileFromApi(f)),
      prUrls: c.prUrls.map((u: string) => parsePrUrl(u)),
      sessions: c.sessions.map((m: never[]) => collectSessionPrUrls(m)),
      cooldown: c.cooldown.map((s: string) => githubReadCooldownMs(s)),
    };
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    const path = join(golden, 'git-pr.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
