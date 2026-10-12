import type { AppSettings, ModelInfo, VaizerCatalog } from '@nekko-agent/shared';
import { updateChecks } from '@nekko-agent/shared';
import { refreshVaizerCatalog } from './vaizer.js';

/**
 * The host's periodic refresh checks (Settings → Updates): re-list every
 * configured provider's models and re-fetch the skills catalog, emitting
 * `modelsUpdated`/`skillsUpdated` when something actually changed. These are
 * metadata refreshes only; the app-version check keeps its own transport-local
 * updater (electron-updater on desktop, server version on web).
 *
 * Provider catalogs like the Codex `/codex/models` endpoint are account- and
 * rollout-aware, so a newer model shows up here without an app release: the
 * first diff lands as an event and the renderer re-lists.
 */

/** How often scheduled checks run. Catalogs move slowly; six hours is plenty. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Let startup settle (providers resolving, engine coming up) before checking. */
const START_DELAY_MS = 8_000;

export interface UpdateChecksService {
  /** Run every check once, ignoring the toggles (Settings → "Check now"). */
  runNow(): Promise<void>;
  stop(): void;
}

export function startUpdateChecks(deps: {
  settings: () => AppSettings;
  listModels: (providerId: string) => Promise<ModelInfo[]>;
  emit: (channel: 'modelsUpdated' | 'skillsUpdated', payload: unknown) => void;
  /** Live skills catalog fetch; injectable for tests. */
  fetchSkillsCatalog?: () => Promise<VaizerCatalog>;
  intervalMs?: number;
  startDelayMs?: number;
}): UpdateChecksService {
  // Last-seen model ids per provider and the skills shelf signature. The first
  // observation seeds without an event, so app start is not a change storm.
  const modelSigs = new Map<string, string>();
  let skillsSig: string | null = null;

  async function checkModelLists() {
    for (const p of deps.settings().providers.filter((x) => x.enabled)) {
      const models = await deps.listModels(p.id).catch(() => null);
      // An empty list reads as a failure (the host itself returns [] on error):
      // never snapshot it, or the next healthy check looks like a change.
      if (!models?.length) continue;
      const sig = models.map((m) => m.id).sort().join('\n');
      const prev = modelSigs.get(p.id);
      modelSigs.set(p.id, sig);
      if (prev !== undefined && prev !== sig) deps.emit('modelsUpdated', { providerId: p.id });
    }
  }

  async function checkSkills() {
    const catalog: VaizerCatalog = await (deps.fetchSkillsCatalog ?? refreshVaizerCatalog)();
    const sig = catalog.skills
      .map((s) => s.id)
      .sort()
      .join('\n');
    const prev = skillsSig;
    skillsSig = sig;
    if (prev !== null && prev !== sig) deps.emit('skillsUpdated', catalog);
  }

  async function tick(manual: boolean) {
    const checks = updateChecks(deps.settings());
    const jobs: Promise<void>[] = [];
    if (manual || checks.modelLists) jobs.push(checkModelLists());
    if (manual || checks.skills) jobs.push(checkSkills());
    // One check must never take the others (or the scheduler) down with it.
    await Promise.allSettled(jobs);
  }

  const boot = setTimeout(() => void tick(false), deps.startDelayMs ?? START_DELAY_MS);
  const timer = setInterval(() => void tick(false), deps.intervalMs ?? INTERVAL_MS);
  boot.unref?.();
  timer.unref?.();

  return {
    runNow: () => tick(true),
    stop: () => {
      clearTimeout(boot);
      clearInterval(timer);
    },
  };
}
