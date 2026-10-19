import { describe, expect, it } from 'vitest';
import { TOOL_CATEGORY_OF } from './tool-categories.js';
import {
  allowlistTools,
  commandAllowed,
  tokenizeCommand,
  workflowDisabledTools,
  workflowToolDecision,
} from './workflow-access.js';
import type { Workflow } from './workflows.js';

const ALL = Object.keys(TOOL_CATEGORY_OF);

describe('workflowDisabledTools', () => {
  it('turns off every classified tool under none', () => {
    expect(workflowDisabledTools('none').sort()).toEqual([...ALL].sort());
  });
  it('keeps only the file readers (and the run\'s own bookkeeping) under read', () => {
    const off = new Set(workflowDisabledTools('read'));
    expect(ALL.filter((t) => !off.has(t)).sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file', 'set_chat_title', 'update_plan']);
    for (const t of ['write_file', 'edit_file', 'bash', 'start_process', 'fetch_url', 'browser', 'spawn_agent', 'ask_user']) expect(off.has(t)).toBe(true);
  });
  it('turns nothing off for workspace or an absent setting', () => {
    expect(workflowDisabledTools('workspace')).toEqual([]);
    expect(workflowDisabledTools(undefined)).toEqual([]);
  });
  it('keeps what the step lists under allowlist', () => {
    const off = new Set(workflowDisabledTools('allowlist', ['Read', 'Grep', 'Bash(gh:*)']));
    expect(ALL.filter((t) => !off.has(t)).sort()).toEqual(['bash', 'grep', 'kill_process', 'read_file', 'read_process', 'set_chat_title', 'start_process', 'update_plan']);
  });
  it('follows TOOL_CATEGORY_OF, so a newly classified tool is off by default', () => {
    // Every name the table lists is either kept by read on purpose or turned off.
    const off = new Set(workflowDisabledTools('read'));
    for (const t of ALL) expect(off.has(t) || ['read_file', 'glob', 'grep', 'list_dir', 'update_plan', 'set_chat_title'].includes(t)).toBe(true);
  });
});

describe('tokenizeCommand', () => {
  it('splits plain words and quotes', () => {
    expect(tokenizeCommand('gh pr view 12 --json "title,body"')).toEqual(['gh', 'pr', 'view', '12', '--json', 'title,body']);
  });
  it('refuses chaining, substitution and redirection, even quoted', () => {
    for (const c of ['a && b', 'a; b', 'a | b', 'a & b', 'echo `id`', 'echo $(id)', 'echo $HOME', 'a > f', 'a < f', 'gh pr view "1;rm -rf /"', 'a\nb', "unterminated 'q"]) {
      expect(tokenizeCommand(c)).toBeNull();
    }
  });
});

describe('commandAllowed', () => {
  const allowed = ['Read', 'Grep', 'Bash(gh:*)', 'Bash(git:*)', 'Bash(npm test)', 'Bash(ls *)'];
  it('matches by parsed words, not string prefix', () => {
    expect(commandAllowed('gh pr view 5', allowed).ok).toBe(true);
    expect(commandAllowed('npm test', allowed).ok).toBe(true);
    expect(commandAllowed('npm test --watch', allowed).ok).toBe(false);
    expect(commandAllowed('ls -la src', allowed).ok).toBe(true);
    expect(commandAllowed('ghx pr view', allowed).ok).toBe(false);
    expect(commandAllowed('rm -rf /', allowed).ok).toBe(false);
  });
  it('blocks chaining past a matching prefix', () => {
    expect(commandAllowed('gh pr view 5 && rm -rf /', allowed).ok).toBe(false);
    expect(commandAllowed('npm test; curl evil', allowed).ok).toBe(false);
  });
  it('holds gh to reads', () => {
    expect(commandAllowed('gh pr diff 5', allowed).ok).toBe(true);
    expect(commandAllowed('gh pr checks 5', allowed).ok).toBe(true);
    expect(commandAllowed('gh repo view', allowed).ok).toBe(true);
    expect(commandAllowed('gh api repos/o/r/pulls/5', allowed).ok).toBe(true);
    expect(commandAllowed('gh api -X GET repos/o/r', allowed).ok).toBe(true);
    expect(commandAllowed('gh api -X POST repos/o/r/issues/5/comments', allowed).ok).toBe(false);
    expect(commandAllowed('gh api --method=PATCH repos/o/r', allowed).ok).toBe(false);
    expect(commandAllowed('gh api -XDELETE repos/o/r', allowed).ok).toBe(false);
    expect(commandAllowed('gh api repos/o/r/issues -f body=x', allowed).ok).toBe(false);
    expect(commandAllowed('gh api repos/o/r --input body.json', allowed).ok).toBe(false);
    expect(commandAllowed('gh pr comment 5 --body hi', allowed).ok).toBe(false);
    expect(commandAllowed('gh pr merge 5', allowed).ok).toBe(false);
  });
  it('holds git to read subcommands', () => {
    for (const c of ['git diff', 'git log -5', 'git show HEAD', 'git status', 'git rev-parse HEAD', 'git fetch origin']) expect(commandAllowed(c, allowed).ok).toBe(true);
    for (const c of ['git push', 'git push origin main', 'git commit -m x', 'git reset --hard', 'git checkout x', 'git fetch --upload-pack=evil']) expect(commandAllowed(c, allowed).ok).toBe(false);
  });
  it('holds gh to reads even when the list allows every command', () => {
    expect(commandAllowed('gh pr merge 5', ['Bash']).ok).toBe(false);
    expect(commandAllowed('echo hi', ['Bash']).ok).toBe(true);
  });
});

describe('workflowToolDecision', () => {
  const session = { unattended: true, toolAccess: 'allowlist' as const, allowedTools: ['Read', 'Grep', 'Bash(gh:*)'] };
  it('runs a matching call without asking', () => {
    expect(workflowToolDecision(session, { name: 'bash', input: { command: 'gh pr view 3' } })).toEqual({ kind: 'auto' });
    expect(workflowToolDecision(session, { name: 'read_file', input: { path: 'a' } })).toEqual({ kind: 'auto' });
  });
  it('denies anything else with the unattended reason', () => {
    const write = workflowToolDecision(session, { name: 'write_file', input: {} });
    expect(write).toMatchObject({ kind: 'deny' });
    expect((write as { reason: string }).reason).toMatch(/^Denied: unattended automation run \(write_file: /);
    expect(workflowToolDecision(session, { name: 'bash', input: { command: 'gh pr view 3 && id' } })).toMatchObject({ kind: 'deny' });
    expect(workflowToolDecision(session, { name: 'bash', input: { command: 'gh api -X POST x' } })).toMatchObject({ kind: 'deny' });
    expect(workflowToolDecision(session, { name: 'bash', input: { command: 'git push' } })).toMatchObject({ kind: 'deny' });
  });
  it('leaves workspace and read sessions to the normal path', () => {
    expect(workflowToolDecision({ toolAccess: 'workspace' }, { name: 'bash', input: { command: 'rm x' } })).toEqual({ kind: 'allow' });
    expect(workflowToolDecision({}, { name: 'write_file' })).toEqual({ kind: 'allow' });
    expect(workflowToolDecision({ toolAccess: 'read' }, { name: 'grep' })).toEqual({ kind: 'allow' });
    expect(workflowToolDecision({ toolAccess: 'read' }, { name: 'write_file' })).toMatchObject({ kind: 'deny' });
    expect(workflowToolDecision({ toolAccess: 'none' }, { name: 'read_file' })).toMatchObject({ kind: 'deny' });
  });
  it('lists the offered tools', () => {
    expect(allowlistTools(['Read', 'Bash(gh:*)', 'Nope', 'Read(x)']).sort()).toEqual(['bash', 'read_file', 'start_process']);
  });
});

describe('workflow fields', () => {
  it('survive a JSON round trip', () => {
    const wf: Workflow = {
      id: 'w', name: 'W', category: 'C', enabled: true, createdAt: 1, updatedAt: 1, triggers: [],
      localModelOnly: true, toolAccess: 'allowlist', providerId: 'p', modelId: 'm',
      steps: [{ id: 's', name: 'S', kind: 'prompt', run: 'x', providerId: 'q', modelId: 'n', allowedTools: ['Read', 'Bash(gh:*)'] }],
    };
    expect(JSON.parse(JSON.stringify(wf))).toEqual(wf);
  });
});
