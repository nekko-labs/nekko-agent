#!/usr/bin/env node
// Fails when code that breaks Anthropic's rules for third-party apps comes back.
//
// Anthropic does not let third-party apps offer Claude.ai login, send requests
// on Claude plan credentials, or collect Claude credentials
// (code.claude.com/docs/en/legal-and-compliance). Nekko Agent used to do all
// three: it signed in with Claude Code's own OAuth client, posed as Claude
// Code on the wire, read Claude Code's credential file and polled plan limits.
// That code is gone, and this check keeps it gone. It also holds the Claude
// approved-client slot (packages/shared/src/oauth-providers.ts and its mirror
// in crates/nekko-oauth) empty: filling it takes Anthropic's written approval
// and a change to this check in the same reviewed PR.
//
// Deliberately not checked: whether a user has CLAUDE_CODE_OAUTH_TOKEN set.
// That is one of Claude Code's own sign-in methods, and refusing to run when
// it is set would itself restrict an authentication method. What is checked
// is that Nekko Agent's code never sets it.
//
//   node scripts/check-claude-compliance.mjs [root]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What must never appear in the code, each with why. */
export const RULES = [
  { id: 'claude-code-client-id', re: /9d1c250a-e61b-44d9-88ed-5944d1962f5e/i, why: "Claude Code's own OAuth client id" },
  { id: 'claude-authorize-url', re: /claude\.(?:com|ai)\/cai\/oauth/i, why: 'the Claude.ai OAuth authorize endpoint' },
  { id: 'claude-token-url', re: /platform\.claude\.com\/v1\/oauth/i, why: 'the Claude OAuth token endpoint' },
  { id: 'oauth-beta-header', re: /oauth-2025-04-20/i, why: 'the beta header that marks a request as sent on plan credentials' },
  { id: 'claude-code-identity', re: /You are Claude Code/i, why: "Claude Code's identity line (impersonating the CLI)" },
  { id: 'plan-rate-limit-headers', re: /anthropic-ratelimit-unified/i, why: "a Claude plan's rate-limit headers" },
  { id: 'plan-usage-endpoint', re: /\/api\/oauth\/usage/i, why: "the Claude plan usage endpoint" },
  { id: 'claude-credentials-file', re: /\.claude\b.{0,120}\.credentials\.json/i, why: "Claude Code's credential file" },
  { id: 'claude-keychain-entry', re: /Claude Code-credentials/i, why: "Claude Code's keychain entry" },
  {
    id: 'sets-claude-code-oauth-token',
    // Assignments and env setters, not reads: `env.X = v`, `{ X: v }`,
    // `env["X"] = v`, `.env("X", v)`, `set_var("X", v)`, `insert("X", v)`,
    // `export X=v`, `$env:X = v`.
    re: /(?:\.env\(\s*|set_var\(\s*|\.insert\(\s*(?:"|'|`))["'`]?CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN["'`]?\]?\s*(?::(?!:)|=(?!=))/,
    why: 'Nekko Agent setting Claude Code\'s OAuth token for it',
  },
];

/**
 * Files that may name these patterns, and which rules each may break. Docs
 * history and the design notes describe what was removed; the check and its
 * test have to spell the patterns out; one test proves the credential file is
 * never read by writing one and asserting nothing imports it.
 */
export const ALLOW = [
  { path: 'scripts/check-claude-compliance.mjs', rules: '*', why: 'the patterns themselves' },
  { path: 'scripts/check-claude-compliance.test.mjs', rules: '*', why: 'seeds violations on purpose' },
  { path: 'docs/superpowers/plans/', rules: '*', why: 'docs history: the plans the removed sign-in shipped from' },
  { path: 'TASKS.md', rules: '*', why: 'task history (T138 and the CL group record what was removed)' },
  {
    path: 'scripts/claude-code-probe.test.mjs',
    rules: ['sets-claude-code-oauth-token'],
    why: 'a fixture environment proving the H0 probe strips the token before starting Claude Code',
  },
];

/** The approved-client slot, TS and Rust: every field must stay null / None. */
export const SLOTS = [
  {
    path: 'packages/shared/src/oauth-providers.ts',
    start: 'export const CLAUDE_APPROVED_CLIENT',
    required: [/state:\s*'awaiting_approval'/, /clientId:\s*null\b/, /authorizeUrl:\s*null\b/, /tokenUrl:\s*null\b/, /scopes:\s*null\b/],
  },
  {
    path: 'crates/nekko-oauth/src/lib.rs',
    start: 'pub const CLAUDE_APPROVED_CLIENT',
    required: [/enabled:\s*false\b/, /client_id:\s*None\b/, /authorize_url:\s*None\b/, /token_url:\s*None\b/, /scopes:\s*None\b/],
  },
];

const TEXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.rs', '.json', '.md', '.mdx', '.toml', '.yml', '.yaml', '.html',
  '.txt', '.css', '.sh', '.ps1', '.swift', '.kt', '.java', '.py', '.go', '.plist', '.xml', '.env', '',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'out', '.worktrees', '.shots']);
const MAX_BYTES = 2 * 1024 * 1024;

const posix = (p) => p.split(sep).join('/');

/** The files to scan: what git knows about (tracked and new), else a walk. */
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(out.split('\0').filter(Boolean))];
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          files.push(posix(relative(root, join(dir, entry.name))));
        }
      }
    };
    walk(root);
    return files;
  }
}

function allowed(file, rule) {
  return ALLOW.some((a) => (a.path.endsWith('/') ? file.startsWith(a.path) : file === a.path) && (a.rules === '*' || a.rules.includes(rule)));
}

/** The literal block a slot starts at, up to its closing brace. */
function slotBlock(text, start) {
  const at = text.indexOf(start);
  if (at < 0) return undefined;
  const open = text.indexOf('{', at);
  const close = text.indexOf('}', open);
  return open < 0 || close < 0 ? undefined : text.slice(open, close + 1);
}

/** Every violation under `root`, as `{ file, line, rule, why }`. */
export function findViolations(root, files = listFiles(root)) {
  const found = [];
  for (const file of files.map(posix)) {
    if (!TEXT.has(extname(file).toLowerCase())) continue;
    if (file.split('/').some((part) => SKIP_DIRS.has(part))) continue;
    let text;
    try {
      const abs = join(root, file);
      if (statSync(abs).size > MAX_BYTES) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted in the working tree, or unreadable
    }
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      if (allowed(file, rule.id)) continue;
      lines.forEach((line, i) => {
        if (rule.re.test(line)) found.push({ file, line: i + 1, rule: rule.id, why: rule.why });
      });
    }
  }
  for (const slot of SLOTS) {
    let text;
    try {
      text = readFileSync(join(root, slot.path), 'utf8');
    } catch {
      found.push({ file: slot.path, line: 0, rule: 'approved-client-slot', why: 'the Claude approved-client slot is missing' });
      continue;
    }
    const block = slotBlock(text, slot.start);
    const missing = block ? slot.required.filter((re) => !re.test(block)) : slot.required;
    if (missing.length) {
      const line = text.slice(0, Math.max(0, text.indexOf(slot.start))).split('\n').length;
      found.push({
        file: slot.path,
        line,
        rule: 'approved-client-slot',
        why: `the Claude approved-client slot is not empty (expected ${missing.map((re) => re.source).join(', ')}). Filling it needs Anthropic's written approval.`,
      });
    }
  }
  return found;
}

function main() {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const found = findViolations(root);
  if (found.length === 0) {
    console.log('Claude compliance check: no violations.');
    return;
  }
  console.error(`Claude compliance check: ${found.length} violation(s).`);
  for (const v of found) console.error(`  ${v.file}:${v.line}  ${v.rule}: ${v.why}`);
  console.error(
    '\nAnthropic does not allow third-party apps to offer Claude.ai login, send requests on Claude plan credentials, or collect Claude credentials. See scripts/check-claude-compliance.mjs.',
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
