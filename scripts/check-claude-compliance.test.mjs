import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findViolations, SLOTS } from './check-claude-compliance.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A tree with the two empty slots copied from this repo, plus `files`. */
function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-compliance-'));
  for (const slot of SLOTS) files[slot.path] ??= readFileSync(join(repo, slot.path), 'utf8');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, list: Object.keys(files) };
}

function check(files) {
  const { root, list } = tree(files);
  try {
    return findViolations(root, list);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rules = (found) => found.map((v) => v.rule);

test('this repository passes', () => {
  assert.deepEqual(findViolations(repo), []);
});

test('a clean tree with empty slots passes', () => {
  assert.deepEqual(check({ 'src/ok.ts': "export const x = 'claude-opus-5-5';\n" }), []);
});

test('a seeded Claude Code client id fails, with its file and line', () => {
  const found = check({ 'packages/host/src/oauth.ts': "const a = 1;\nconst CLIENT = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';\n" });
  assert.deepEqual(found.map(({ file, line, rule }) => ({ file, line, rule })), [
    { file: 'packages/host/src/oauth.ts', line: 2, rule: 'claude-code-client-id' },
  ]);
});

test('every impersonation, credential and plan-limit pattern is caught', () => {
  const found = check({
    'a.ts': "fetch('https://claude.com/cai/oauth/authorize');\n",
    'b.rs': 'const URL: &str = "https://platform.claude.com/v1/oauth/token";\n',
    'c.ts': "headers['anthropic-beta'] = 'oauth-2025-04-20';\n",
    'd.ts': "const prefix = \"You are Claude Code, Anthropic's official CLI for Claude.\";\n",
    'e.rs': 'let k = "anthropic-ratelimit-unified-5h-utilization";\n',
    'f.ts': "await fetch('https://api.anthropic.com/api/oauth/usage');\n",
    'g.ts': "readFileSync(join(homedir(), '.claude', '.credentials.json'));\n",
    'h.rs': 'home.join(".claude").join(".credentials.json")\n',
    'i.swift': 'let service = "Claude Code-credentials"\n',
  });
  assert.deepEqual(rules(found).sort(), [
    'claude-authorize-url',
    'claude-code-identity',
    'claude-credentials-file',
    'claude-credentials-file',
    'claude-keychain-entry',
    'claude-token-url',
    'oauth-beta-header',
    'plan-rate-limit-headers',
    'plan-usage-endpoint',
  ]);
});

test('setting CLAUDE_CODE_OAUTH_TOKEN fails; reading or naming it does not', () => {
  const sets = check({
    'a.ts': 'process.env.CLAUDE_CODE_OAUTH_TOKEN = token;\n',
    'b.ts': 'spawn(bin, args, { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } });\n',
    'c.rs': 'cmd.env("CLAUDE_CODE_OAUTH_TOKEN", token);\n',
    'd.rs': 'std::env::set_var("CLAUDE_CODE_OAUTH_TOKEN", token);\n',
    'e.ts': "env['CLAUDE_CODE_OAUTH_TOKEN'] = token;\n",
    'f.sh': 'export CLAUDE_CODE_OAUTH_TOKEN=abc\n',
  });
  assert.deepEqual(rules(sets), Array(6).fill('sets-claude-code-oauth-token'));
  // A user's own Claude Code auth method is theirs: reading it is not setting it,
  // and nothing here may refuse to run because it is set.
  const reads = check({
    'a.ts': 'if (process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined) {}\n',
    'b.md': 'Nekko Agent never sets CLAUDE_CODE_OAUTH_TOKEN.\n',
    'c.rs': 'let _ = std::env::var("CLAUDE_CODE_OAUTH_TOKEN");\n',
  });
  assert.deepEqual(reads, []);
});

test('a filled approved-client slot fails, in TS and in Rust', () => {
  const ts = readFileSync(join(repo, SLOTS[0].path), 'utf8').replace(/clientId:\s*null/, "clientId: 'some-client'");
  assert.deepEqual(rules(check({ [SLOTS[0].path]: ts })), ['approved-client-slot']);
  const rs = readFileSync(join(repo, SLOTS[1].path), 'utf8').replace(/client_id:\s*None/, 'client_id: Some("x")');
  assert.deepEqual(rules(check({ [SLOTS[1].path]: rs })), ['approved-client-slot']);
});

test('a missing slot fails', () => {
  const { root } = tree();
  try {
    rmSync(join(root, SLOTS[0].path));
    assert.deepEqual(rules(findViolations(root, [])), ['approved-client-slot']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs history may describe what was removed; other docs may not', () => {
  const line = 'Requests sent the oauth-2025-04-20 beta header.\n';
  assert.deepEqual(check({ 'docs/superpowers/plans/2026-09-08-subscription-signin.md': line }), []);
  assert.deepEqual(rules(check({ 'docs/SUBSCRIPTIONS.md': line })), ['oauth-beta-header']);
});
