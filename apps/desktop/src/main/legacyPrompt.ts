import { cleanup, consolidate, describeItem, detectLegacy, legacyEnv, summarize, type LegacyEnv, type LegacyItem } from '@nekko-agent/host/legacy-profiles';

/**
 * The launch-time offer to fold earlier installs into the current data folder.
 *
 * Runs before the engine starts, so nothing else has the data folder open and
 * no restart is needed afterwards. Shown on every launch while anything is left
 * (the answer "Not now" is not remembered), and silent when there is nothing to
 * do: detection is existence checks only. The same work is available from a
 * terminal as `nekko-agent migrate`, which also closes and reopens a running app.
 */

export type LegacyChoice = 'merge-clean' | 'merge-keep' | 'later';

export interface LegacyPromptDeps {
  /** Show the question; return the button picked. */
  ask: (message: string, detail: string) => LegacyChoice;
  /** Report the outcome (or a failure) after the choice was acted on. */
  tell: (title: string, detail: string, error: boolean) => void;
  env?: LegacyEnv;
  detect?: typeof detectLegacy;
  describe?: typeof describeItem;
  merge?: typeof consolidate;
  clean?: typeof cleanup;
}

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

export function describeOffer(items: LegacyItem[], target: string, describe: typeof describeItem = describeItem): { message: string; detail: string } {
  const lines = summarize(items, describe).map((row) => {
    const extra = row.sessions ? `${row.sessions} chat${row.sessions === 1 ? '' : 's'}, ` : '';
    return `• ${row.text} (${extra}${size(row.bytes)})`;
  });
  return {
    message: 'Earlier Nekko Agent installs were found',
    detail: `${lines.join('\n')}\n\nMerge their chats, spending history, settings and models into ${target}? Nothing there is overwritten, and a backup of the files that change is saved first. "Merge and clean up" then deletes the old copies.`,
  };
}

/** Returns true when something was merged (the caller need not do anything else either way). */
export function offerLegacyCleanup(deps: LegacyPromptDeps): boolean {
  const env = deps.env ?? legacyEnv();
  let items: LegacyItem[];
  try { items = (deps.detect ?? detectLegacy)(env); } catch { return false; }
  if (!items.length) return false;
  const { message, detail } = describeOffer(items, env.target, deps.describe);
  const choice = deps.ask(message, detail);
  if (choice === 'later') return false;
  try {
    const merged = (deps.merge ?? consolidate)(items, env, { ignorePids: [process.pid] });
    const counts = merged.roots.reduce((a, r) => ({ s: a.s + r.sessions, u: a.u + r.usageRecords }), { s: 0, u: 0 });
    let report = `Merged ${counts.s} chats and ${counts.u} usage records. Backup: ${merged.backupDir}`;
    let error = false;
    if (choice === 'merge-clean') {
      const cleaned = (deps.clean ?? cleanup)(items, env);
      report += `\nRemoved ${cleaned.removed.length} old folder${cleaned.removed.length === 1 ? '' : 's'}.`;
      for (const k of cleaned.kept) { report += `\nKept ${k.path}: ${k.reason}`; error = true; }
      for (const f of cleaned.failed) { report += `\nCould not remove ${f.path}: ${f.error}`; error = true; }
    }
    deps.tell('Nekko Agent data merged', report, error);
    return true;
  } catch (e) {
    deps.tell('Merge stopped', `${(e as Error).message}\nNothing that was merged has been deleted. You will be asked again next launch, or run "nekko-agent migrate".`, true);
    return false;
  }
}
