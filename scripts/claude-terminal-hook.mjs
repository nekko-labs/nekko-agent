// Opt-in Claude Code hook. Emits only event/tool names, never prompt or tool arguments.
// Configure explicitly; this script never edits Claude settings and never approves tools.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function terminalHookSequence(event) {
  const name = event?.hook_event_name;
  const tool = typeof event?.tool_name === 'string' ? event.tool_name.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64) : '';
  let state, detail;
  switch (name) {
    case 'UserPromptSubmit': state = 'working'; detail = 'Claude Code · Working'; break;
    case 'PreToolUse': state = 'working'; detail = tool ? `Claude Code · ${tool}` : 'Claude Code · Using a tool'; break;
    case 'PermissionRequest': state = 'attention'; detail = 'Claude Code needs permission'; break;
    case 'Notification':
      if (event.notification_type === 'permission_prompt') { state = 'attention'; detail = 'Claude Code needs permission'; }
      else if (event.notification_type === 'idle_prompt') { state = 'attention'; detail = 'Claude Code needs input'; }
      else return '';
      break;
    case 'Stop': state = 'idle'; detail = 'Claude Code · Turn finished'; break;
    case 'SessionEnd': state = 'idle'; detail = 'Claude Code · Session ended'; break;
    default: return '';
  }
  return `\x1b]777;nekko;${state};${detail}\x07`;
}

async function main() {
  if (!process.env.NEKKO_TERMINAL_ID || process.platform === 'win32') return;
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) return;
    chunks.push(chunk);
  }
  const sequence = terminalHookSequence(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!sequence) return;
  const fd = fs.openSync('/dev/tty', 'w');
  try { fs.writeSync(fd, sequence); } finally { fs.closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Fail open and silently: metadata must never block Claude or leak input in errors.
  const timeout = setTimeout(() => process.exit(0), 1000);
  main().catch(() => {}).finally(() => { clearTimeout(timeout); });
}
