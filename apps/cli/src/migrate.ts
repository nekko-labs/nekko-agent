import { createInterface } from 'node:readline/promises';
import {
  cleanupLegacy,
  consolidateLegacy,
  describeLegacyItem,
  detectLegacy,
  findRunningApp,
  legacyEnv,
  startApp,
  stopApp,
  summarizeLegacy,
  type LegacyItem,
} from '@nekko-agent/host';

export const MIGRATE_HELP = `nekko-agent migrate, bring data from earlier installs into the current data folder.

Usage:
  nekko-agent migrate [--dry-run] [--yes] [--keep-old] [--no-restart]

Finds data, installs and caches left by earlier names of this app (Kotrain, Open Paw,
Agent Nekko, ~/.nekko, ...). It merges their sessions, usage and spending history,
settings, sign-ins and model files into the current data folder without overwriting
anything there, then deletes what it merged.

  --dry-run      Show what was found and what would happen, change nothing
  --yes          Do not ask for confirmation
  --keep-old     Merge but leave the old folders and installs in place
  --no-restart   Do not reopen the app afterwards

If the Nekko Agent app is running it is closed first (asking nicely, then forcing),
and reopened when the merge is done. A backup of the files that change is written to
<data folder>/backups/legacy-<time>/ before anything is merged.`;

export interface MigrateIo {
  out: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

function summaryLines(items: LegacyItem[]): string[] {
  return summarizeLegacy(items, describeLegacyItem).map((row) => {
    const label = row.kind === 'app-data' ? 'data' : row.kind;
    const detail = [row.sessions ? `${row.sessions} session${row.sessions === 1 ? '' : 's'}` : '', gb(row.bytes)].filter(Boolean).join(', ');
    return `  ${label.padEnd(8)} ${row.text}  (${detail})`;
  });
}

export async function runMigrate(flags: Record<string, string | boolean>, io: MigrateIo): Promise<number> {
  const env = legacyEnv();
  const items = detectLegacy(env);
  if (!items.length) { io.out('Nothing to migrate: no earlier installs or data folders were found.'); return 0; }
  io.out(`Into: ${env.target}\n\nFound:\n${summaryLines(items).join('\n')}\n`);
  const dataRoots = [...new Set(items.flatMap((i) => i.dataRoots))];
  const running = findRunningApp([env.target, ...dataRoots]);
  if (running) io.out(`Nekko Agent is running (pid ${running.main.pid}); it will be closed${running.relaunch ? ' and reopened' : ''}.\n`);
  if (flags['dry-run']) { io.out('Dry run: nothing was changed.'); return 0; }
  if (flags.yes !== true && !(await io.confirm(`Merge into ${env.target}${flags['keep-old'] === true ? '' : ' and delete the old copies'}?`))) { io.out('Cancelled; nothing was changed.'); return 1; }

  if (running) {
    io.out('Closing Nekko Agent…');
    const { graceful } = await stopApp(running);
    io.out(graceful ? 'Closed.' : 'It did not close on request and was stopped.');
  }
  let code = 0;
  try {
    const merged = consolidateLegacy(items, env);
    io.out(`Backup of changed files: ${merged.backupDir}`);
    for (const r of merged.roots) io.out(`  merged ${r.source}: ${r.sessions} sessions, ${r.usageRecords} usage records, ${r.moved.length} items moved${r.conflicts.length ? `, ${r.conflicts.length} left in place (name clash)` : ''}`);
    if (flags['keep-old'] !== true) {
      const cleaned = cleanupLegacy(items, env);
      for (const p of cleaned.removed) io.out(`  removed ${p}`);
      for (const k of cleaned.kept) { io.out(`  kept    ${k.path}: ${k.reason}`); code = 1; }
      for (const f of cleaned.failed) { io.out(`  failed  ${f.path}: ${f.error}`); code = 1; }
    }
  } catch (e) {
    io.out(`Migration stopped: ${(e as Error).message}\nNothing that was merged has been deleted. Re-run to continue.`);
    code = 1;
  }
  if (running?.relaunch && flags['no-restart'] !== true) { io.out('Reopening Nekko Agent…'); startApp(running.relaunch); }
  else if (running && !running.relaunch) io.out('Start Nekko Agent again the way you usually do (it was a development build).');
  return code;
}

export async function migrateCommand(flags: Record<string, string | boolean>): Promise<number> {
  if (flags.help) { console.log(MIGRATE_HELP); return 0; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runMigrate(flags, {
      out: (line) => console.log(line),
      confirm: async (q) => /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()),
    });
  } finally { rl.close(); }
}
