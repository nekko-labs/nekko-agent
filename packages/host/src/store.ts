import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AppSettings } from '@nekko-agent/shared';
import { DEFAULT_PROMPTS, DEFAULT_SPEC_METHODOLOGY, DEFAULT_ORCHESTRATION, DEFAULT_ACCENT, LEGACY_ACCENTS, uniqueFolders } from '@nekko-agent/shared';
import { DEFAULT_GUARDRAILS } from '@nekko-agent/core';
import { dataDir } from './paths.js';
import { ensurePrivateFile, writeJsonAtomic } from './secure-file.js';

export { dataDir } from './paths.js';

const SETTINGS_PATH = () => join(dataDir(), 'settings.json');

/** A fresh copy of the settings a new install starts with (the daemon's port embeds them, see store.golden.test.ts). */
export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    promptCaching: true,
    accent: DEFAULT_ACCENT,
    sandboxMode: 'workspace-jail',
    providers: [],
    guardrails: DEFAULT_GUARDRAILS,
    workspaces: [],
    connectors: [],
    mascotEnabled: true,
    prompts: DEFAULT_PROMPTS,
    favoriteModels: [],
    mcpServers: [],
    specMethodology: DEFAULT_SPEC_METHODOLOGY,
    orchestration: DEFAULT_ORCHESTRATION,
  };
}

// Keyed by data dir so a single process serving many accounts (Nekko Agent Cloud)
// never bleeds one account's settings into another. Single-data-dir editions
// (desktop/server/CLI) just use the one entry.
const cache = new Map<string, AppSettings>();

export function getSettings(): AppSettings {
  const dir = dataDir();
  const cached = cache.get(dir);
  if (cached) return cached;
  let settings: AppSettings;
  try {
    if (existsSync(SETTINGS_PATH())) {
      ensurePrivateFile(SETTINGS_PATH());
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH(), 'utf8'));
      settings = { ...defaultSettings(), ...parsed };
      // Normalize array fields from older or partially-written settings files.
      if (!Array.isArray(settings.providers)) settings.providers = [];
      if (!Array.isArray(settings.guardrails) || settings.guardrails.length === 0) settings.guardrails = DEFAULT_GUARDRAILS;
      if (!Array.isArray(settings.workspaces)) settings.workspaces = [];
      if (!Array.isArray(settings.connectors)) settings.connectors = [];
      if (!Array.isArray(settings.prompts)) settings.prompts = DEFAULT_PROMPTS;
      if (!Array.isArray(settings.favoriteModels)) settings.favoriteModels = [];
      if (!Array.isArray(settings.mcpServers)) settings.mcpServers = [];
      // Replies no longer have a tool-step limit; drop the old setting so the
      // next save stops carrying it.
      delete (settings as { maxSteps?: unknown }).maxSteps;
      // Migrate users off a prior default accent (e.g. the old orange) so the
      // refreshed color applies unless they picked their own.
      if (settings.accent && LEGACY_ACCENTS.includes(settings.accent.toLowerCase())) {
        settings.accent = DEFAULT_ACCENT;
      }
    } else {
      settings = defaultSettings();
    }
  } catch {
    settings = defaultSettings();
  }
  cache.set(dir, settings);
  return settings;
}

/** `{ ...current, ...patch }`, with one entry per folder in `patch.workspaces`. */
function merged(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const next = { ...current, ...patch };
  // Every writer (add, reorder, import, a merge) goes through here, so this is
  // where one folder can never be listed twice.
  if (patch.workspaces) next.workspaces = uniqueFolders(patch.workspaces).folders;
  return next;
}

/**
 * Under the engine daemon, settings.json is the daemon's to write
 * (crates/nekko-settings, crates/nekkod/src/settings.rs): this host keeps its
 * cached copy, applies its own changes to it at once (callers stay
 * synchronous) and sends them to the daemon in order. The daemon tells it
 * about changes made elsewhere through `settingsChanged`.
 */
type SettingsWriter = (channel: 'settings:save' | 'settings:resetHost', args: unknown[]) => Promise<AppSettings>;
let writer: SettingsWriter | undefined;
let inFlight = 0;
let queue: Promise<unknown> = Promise.resolve();

export function useSettingsDaemon(write: SettingsWriter | null): void {
  writer = write ?? undefined;
}

function send(write: SettingsWriter, dir: string, channel: 'settings:save' | 'settings:resetHost', args: unknown[]): void {
  inFlight += 1;
  queue = queue
    .then(() => write(channel, args))
    .then(
      (saved) => {
        inFlight -= 1;
        // Once nothing of ours is still on its way, the daemon's copy is the truth.
        if (inFlight === 0 && saved && typeof saved === 'object') cache.set(dir, saved);
      },
      (e: unknown) => {
        inFlight -= 1;
        console.error(`settings: the daemon did not save a change: ${(e as Error)?.message ?? e}`);
      },
    );
}

/** Wait for every change this host sent to the daemon (tests, shutdown). */
export function settingsSaved(): Promise<void> {
  return queue.then(() => undefined);
}

/**
 * The daemon saved a change this host did not make (the UI's
 * `settings:update` or `settings:reset`): follow it. While changes of ours
 * are still on their way, the patch is applied to our copy instead, so they
 * are not lost from it before the daemon answers.
 */
export function settingsChanged(next: AppSettings, patch: Partial<AppSettings> | null): void {
  const dir = dataDir();
  if (inFlight > 0 && patch && typeof patch === 'object') cache.set(dir, merged(getSettings(), patch));
  else cache.set(dir, next);
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = merged(getSettings(), patch);
  const dir = dataDir();
  cache.set(dir, next);
  if (writer) send(writer, dir, 'settings:save', [patch]);
  else writeJsonAtomic(SETTINGS_PATH(), next);
  return next;
}

/** Reset all settings (theme, providers, guardrails, prompts, …) to defaults. */
export function resetSettings(): AppSettings {
  const next = defaultSettings();
  const dir = dataDir();
  cache.set(dir, next);
  if (writer) send(writer, dir, 'settings:resetHost', []);
  else writeJsonAtomic(SETTINGS_PATH(), next);
  return next;
}
