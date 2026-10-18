import { describe, expect, it } from 'vitest';
import type { HookRule } from '@nekko-agent/shared';
import { decisionOf, hasToolHooks, matchingHooks, postToolHooks, preToolHooks, runHook } from './hooks.js';

const cwd = process.cwd();
const ctx = { sessionId: 's1', cwd };
const call = { id: 'c1', name: 'bash', input: { command: 'rm -rf build' } };
const rule = (over: Partial<HookRule>): HookRule => ({ id: over.id ?? 'h', event: 'PreToolUse', command: 'exit 0', ...over });

/** A hook written in node, so it runs the same on cmd.exe and sh. */
const node = (script: string) => `node -e "${script.replace(/"/g, '\\"')}"`;

describe('hooks', () => {
  it('matches by event and tool name, as a regex or a list, and knows when any tool hook is on', () => {
    const settings = {
      hooks: [
        rule({ id: 'a', matcher: 'bash|write_file' }),
        rule({ id: 'b', matcher: '' }),
        rule({ id: 'c', event: 'PostToolUse', matcher: 'read_.*' }),
        rule({ id: 'd', enabled: false }),
        rule({ id: 'e', event: 'TurnEnd' }),
      ],
    };
    expect(matchingHooks(settings, 'PreToolUse', 'bash').map((h) => h.id)).toEqual(['a', 'b']);
    expect(matchingHooks(settings, 'PreToolUse', 'grep').map((h) => h.id)).toEqual(['b']);
    expect(matchingHooks(settings, 'PostToolUse', 'read_file').map((h) => h.id)).toEqual(['c']);
    expect(matchingHooks(settings, 'TurnEnd').map((h) => h.id)).toEqual(['e']);
    expect(hasToolHooks(settings)).toBe(true);
    expect(hasToolHooks({ hooks: [rule({ event: 'TurnEnd' })] })).toBe(false);
    expect(hasToolHooks({})).toBe(false);
  });

  it('hands the event to the command as JSON on stdin and reads its decision', async () => {
    const echo = rule({ command: node("let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);console.log(p.event+':'+p.tool.name+':'+process.env.NEKKO_HOOK_EVENT)})") });
    const out = await runHook(echo, { event: 'PreToolUse', sessionId: 's1', cwd, tool: { id: 'c1', name: 'bash', input: {} } });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('PreToolUse:bash:PreToolUse');
    expect(decisionOf(out)).toEqual({ block: false, reason: '' });
    expect(decisionOf({ ...out, code: 2, stderr: 'no deletes today' })).toEqual({ block: true, reason: 'no deletes today' });
    expect(decisionOf({ ...out, stdout: '{"decision":"block","reason":"policy"}' })).toEqual({ block: true, reason: 'policy' });
  });

  it('blocks a tool on exit code 2 with the reason for the model, and lets others through', async () => {
    const settings = {
      hooks: [
        rule({ id: 'allow', command: node("console.log('fine')") }),
        rule({ id: 'deny', name: 'no-rm', matcher: 'bash', command: node("console.error('rm is off limits');process.exit(2)") }),
        // Behind the blocking hook for bash; not for other tools.
        rule({ id: 'never', matcher: 'bash', command: node("console.log('unreached');process.exit(2)") }),
      ],
    };
    const blocked = await preToolHooks(settings, call, ctx);
    expect(blocked.block).toBe('Blocked by hook no-rm: rm is off limits');
    const allowed = await preToolHooks(settings, { ...call, name: 'read_file' }, ctx);
    expect(allowed.block).toBeUndefined();
  });

  it('appends what PostToolUse hooks print to the tool result, and skips the rest', async () => {
    const settings = {
      hooks: [
        rule({ event: 'PostToolUse', name: 'lint', command: node("console.log('2 warnings')") }),
        rule({ event: 'PostToolUse', command: node('') }),
        rule({ event: 'PreToolUse', command: node("console.log('pre, not post')") }),
      ],
    };
    const result = await postToolHooks(settings, call, { toolCallId: 'c1', output: 'done' }, ctx);
    expect(result.output).toBe('done\n\n[hook lint]: 2 warnings');
    const untouched = await postToolHooks({ hooks: [] }, call, { toolCallId: 'c1', output: 'done' }, ctx);
    expect(untouched.output).toBe('done');
  });

  it('never lets a hook that hangs or cannot start block the tool', async () => {
    const settings = {
      hooks: [
        // 1 s is the shortest limit runHook allows; sleeping 2.5 s still outlasts it.
        // Kept short because on Windows killing cmd.exe leaves the node grandchild
        // holding the pipes, so the outcome only settles when the sleep ends.
        rule({ name: 'slow', command: node('setTimeout(()=>{},2500)'), timeoutMs: 1_000 }),
        rule({ name: 'missing', command: 'definitely-not-a-command-xyz' }),
      ],
    };
    const out = await preToolHooks(settings, call, ctx);
    expect(out.block).toBeUndefined();
    expect(out.notes).toEqual(['[hook slow timed out and was ignored]']);
  }, 15_000);

  it('preserves the hook decision when it closes stdin before a large payload is written', async () => {
    const out = await runHook(rule({ command: 'exit 2' }), {
      event: 'PreToolUse', sessionId: 's1', cwd,
      tool: { id: 'c1', name: 'bash', input: { text: 'x'.repeat(1024 * 1024) } },
    });
    expect(out.code).toBe(2);
    expect(out.timedOut).toBe(false);
    expect(decisionOf(out).block).toBe(true);
  });
});
