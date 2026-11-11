import type { TerminalInfo } from '@nekko-agent/shared';

/**
 * Shell code blocks the agent writes for the user to run (#2595): which fences
 * count, what of the block is typed into the terminal, and which terminal is
 * the chat's own. Pure, so the rules are tested without a terminal.
 */

/** Fences written as a script: every line is typed as it is. */
const SCRIPT_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'ps', 'pwsh', 'cmd', 'bat', 'batch']);
/** Fences written as a session: prompt lines are commands, the rest is output. */
const SESSION_LANGS = new Set(['console', 'shell-session', 'shellsession', 'terminal', 'pwsh-session', 'ps1-session', 'doscon']);

/** The fence's language word: `bash title="x"` and ` Bash ` read as `bash`. */
function langWord(lang: string): string {
  return lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/** True for a fence the user may run in a terminal. */
export function isShellLang(lang: string): boolean {
  const word = langWord(lang);
  return SCRIPT_LANGS.has(word) || SESSION_LANGS.has(word);
}

/**
 * A prompt at the start of a session line: `$ `, `% `, `PS> `, `PS C:\repo> `,
 * `C:\repo> `. Not `# ` (in a session block far more often a comment than a
 * root prompt) and not `> ` (npm prints its script lines that way): neither
 * may run. `> ` counts only as the continuation prompt after a line that goes on.
 */
const SESSION_PROMPT_RE = /^\s*(?:(?:PS(?: [^>\n]*)?>|[A-Za-z]:\\[^>\n]*>)\s?|[$%]\s)(.*)$/;
const CONTINUATION_PROMPT_RE = /^\s*>\s?/;
/**
 * A prompt a model pastes in front of a script line. `#` and `>` are left
 * alone there: in a script they are a comment and a redirection.
 */
const SCRIPT_PROMPT_RE = /^(\s*)(?:PS(?: [^>\n]*)?> ?|[A-Za-z]:\\[^>\n]*> ?|[$%] )(.*)$/;

/** A line that goes on onto the next: a trailing `\` (sh) or backtick (PowerShell), or an open `|` / `&&`. */
function continues(line: string): boolean {
  return /(?:\\|`|\||&&)\s*$/.test(line);
}

function trimBlankEnds(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

/**
 * What Run types into the terminal for a fence, or null when there is
 * nothing to run. A session block (`console`) keeps its prompt lines, and the
 * lines they continue onto, without the prompt; a block with no prompt at all
 * is taken as plain commands. A script block keeps every line, minus a `$ `
 * or `PS> ` prompt a model wrote in front of one. Lines are joined with a
 * carriage return, the key a shell reads as Enter.
 */
export function commandToRun(lang: string, code: string): string | null {
  if (!isShellLang(lang)) return null;
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  let kept: string[];
  const session = SESSION_LANGS.has(langWord(lang));
  if (session && !lines.some((l) => SESSION_PROMPT_RE.test(l))) {
    // A session block without prompts is plain commands, but a `>` line
    // there is output (or a redirect that would empty a file), and `#` a note.
    kept = lines.filter((l) => !/^\s*[>#]/.test(l));
  } else if (session) {
    kept = [];
    let carry = false;
    for (const line of lines) {
      const prompt = SESSION_PROMPT_RE.exec(line);
      if (prompt) {
        kept.push(prompt[1]);
        carry = continues(prompt[1]);
      } else if (carry) {
        const next = line.replace(CONTINUATION_PROMPT_RE, '');
        kept.push(next);
        carry = continues(next);
      }
    }
  } else {
    kept = lines.map((line) => {
      const prompt = SCRIPT_PROMPT_RE.exec(line);
      return prompt ? prompt[1] + prompt[2] : line;
    });
  }
  const out = trimBlankEnds(kept.map((l) => l.replace(/\s+$/, '')));
  return out.length ? out.join('\r') : null;
}

/**
 * The chat's connected terminal: a running shell opened for this chat (not
 * the agent's read-only command log), the one Run used last if it is still
 * there, else the newest.
 */
export function pickChatTerminal(terminals: TerminalInfo[], sessionId: string, preferId?: string): TerminalInfo | undefined {
  const mine = terminals.filter((t) => t.sessionId === sessionId && t.running && !t.id.startsWith('agent_') && !t.agentSessionId);
  return mine.find((t) => t.id === preferId) ?? [...mine].sort((a, b) => b.createdAt - a.createdAt)[0];
}

/* eslint-disable no-control-regex */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC_RE = /\x1b[@-Z\\-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * A terminal's raw scroll-back as plain text for a chat message: escape
 * sequences dropped, a carriage-return overwrite kept as what it left on
 * screen, runs of blank lines folded, and only the last `maxLines` lines.
 */
export function terminalText(raw: string, maxLines = 80): string {
  const plain = raw.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '');
  const lines = plain.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const parts = line.split('\r').filter((p) => p.length);
    return (parts.at(-1) ?? '').replace(CONTROL_RE, '').replace(/\s+$/, '');
  });
  const folded: string[] = [];
  for (const line of trimBlankEnds(lines)) {
    if (!line && !folded.at(-1)) continue;
    folded.push(line);
  }
  return folded.slice(-maxLines).join('\n');
}

/** The composer text Share output adds: the output in a plain fence the model reads as-is. */
export function sharedOutputMessage(text: string): string {
  const fence = text.includes('```') ? '````' : '```';
  return `Output from my terminal:\n\n${fence}text\n${text}\n${fence}`;
}
