#!/usr/bin/env node
// One-off profile repair for a data folder that already holds duplicates:
// several provider entries for one subscription account, several folder
// entries for one path, and servers the user wants to forget. New merges
// dedupe on their own (legacy-profiles.ts); this applies the same logic to a
// profile merged before that existed.
//
//   node scripts/repair-profile.mjs                 dry run (default)
//   node scripts/repair-profile.mjs --apply         write, after a backup
//   --keep <providerId>     survivor for its group (repeatable)
//   --remove <providerId>   drop a provider outright (repeatable)
//   --account <tokenKey>=<accountId>   tell it two tokens are one account
//   --data <dir>            default ~/.nekko-agent
//
// Refuses to write while the app is serving from the folder: it would write
// its in-memory settings back over this on exit.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dedupeProfile, liveInstance } from '../packages/host/dist/legacy-profiles.js';

const argv = process.argv.slice(2);
const many = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const root = many('--data')[0] ?? join(homedir(), '.nekko-agent');
const apply = argv.includes('--apply');
const keep = Object.fromEntries(many('--keep').map((id, i) => [String(i), id]));
const removeProviders = many('--remove');
const accounts = Object.fromEntries(many('--account').map((s) => s.split('=')));

const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
const label = (id) => { const p = settings.providers.find((x) => x.id === id); return p ? `${id} (${p.label ?? p.kind}${p.baseUrl ? `, ${p.baseUrl}` : ''})` : id; };
const folder = (id) => { const w = settings.workspaces.find((x) => x.id === id); return w ? `${id} ${w.name} ${w.path}` : id; };

const live = liveInstance(root);
if (apply && live) { console.error(`Nekko Agent is running (process ${live}). Quit it first; it would overwrite these changes on exit.`); process.exit(1); }

let plan;
if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(root, 'backups', `repair-${stamp}`);
  mkdirSync(backup, { recursive: true });
  for (const f of readdirSync(root)) if (/\.(json|jsonl)$/.test(f)) cpSync(join(root, f), join(backup, f));
  if (existsSync(join(root, 'sessions'))) cpSync(join(root, 'sessions'), join(backup, 'sessions'), { recursive: true });
  console.log(`Backup: ${backup}`);
  plan = dedupeProfile(root, process.platform, { accountOf: (k) => accounts[k], keepProvider: keep, removeProviders });
} else {
  // Dry run against a scratch copy of settings + tokens only, so nothing in root changes.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const scratch = mkdtempSync(join(tmpdir(), 'nekko-repair-dry-'));
  for (const f of ['settings.json', 'tokens.json', 'usage.jsonl']) if (existsSync(join(root, f))) cpSync(join(root, f), join(scratch, f));
  if (existsSync(join(root, 'sessions'))) {
    mkdirSync(join(scratch, 'sessions'));
    for (const f of readdirSync(join(root, 'sessions'))) if (f.endsWith('.json')) {
      try { const s = JSON.parse(readFileSync(join(root, 'sessions', f), 'utf8')); writeFileSync(join(scratch, 'sessions', f), JSON.stringify({ id: s.id, workspaceId: s.workspaceId, providerId: s.providerId })); } catch {}
    }
  }
  plan = dedupeProfile(scratch, process.platform, { accountOf: (k) => accounts[k], keepProvider: keep, removeProviders });
  rmSync(scratch, { recursive: true, force: true });
}

console.log(apply ? '\nApplied:' : '\nDry run (nothing changed). Would apply:');
for (const [from, to] of Object.entries(plan?.providers ?? {})) console.log(`  provider  ${label(from)}  ->  ${to}`);
for (const id of plan?.removeProviders ?? []) console.log(`  remove    ${label(id)}`);
for (const [from, to] of Object.entries(plan?.folders ?? {})) console.log(`  folder    ${folder(from)}  ->  ${to}`);
if (!apply) console.log('\nRe-run with --apply after quitting Nekko Agent.');
