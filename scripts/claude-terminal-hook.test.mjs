import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminalHookSequence } from './claude-terminal-hook.mjs';
test('hooks emit explicit states without prompt, tool arguments or notification messages', () => {
  for (const [name, state] of [['UserPromptSubmit','working'], ['PreToolUse','working'], ['PermissionRequest','attention'], ['Stop','idle'], ['SessionEnd','idle']]) {
    const seq = terminalHookSequence({hook_event_name:name, tool_name:'Edit', prompt:'SECRET', tool_input:{content:'SECRET'}, message:'SECRET'});
    assert(seq.startsWith(`\x1b]777;nekko;${state};`)); assert(!seq.includes('SECRET'));
  }
  assert.equal(terminalHookSequence({hook_event_name:'Notification', notification_type:'auth_success'}), '');
  assert(terminalHookSequence({hook_event_name:'Notification', notification_type:'permission_prompt'}).includes('needs permission'));
  assert(!terminalHookSequence({hook_event_name:'PreToolUse',tool_name:'\x1b]2;evil\x07'}).includes('\x1b]2;'));
});
test('non-Nekko and malformed invocations do not block or write to stdout', () => {
  for (const input of ['{}', 'not json']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./claude-terminal-hook.mjs', import.meta.url))], {input, encoding:'utf8', env:{...process.env,NEKKO_TERMINAL_ID:''},timeout:2000});
    assert.equal(result.status,0); assert.equal(result.stdout,''); assert.equal(result.stderr,'');
  }
});
