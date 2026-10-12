import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { VaizerCatalog, VaizerCatalogSkill } from '@nekko-agent/shared';
import {
  VAIZER_CATALOG_URL,
  VAIZER_SNAPSHOT,
  vaizerLegacySkillMdUrl,
  vaizerSkillMdUrl,
} from '@nekko-agent/shared';
import { dataDir } from './store.js';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns } from './daemon-caps.js';

/**
 * Vaizer skills marketplace (github.com/nekko-labs/vaizer), an optional
 * integration. Offline-first: the shelf renders from the bundled snapshot
 * (or the last cached live fetch) with zero network; a live fetch happens only
 * when the user explicitly refreshes, and a skill's SKILL.md is fetched at
 * install time so the real instructions get installed. Lives host-side so it
 * works in every edition (browser CSP / Docker can't fetch cross-origin).
 */

const FETCH_TIMEOUT_MS = 6000;

function cacheFile(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'vaizer.json');
}

function readCache(): VaizerCatalog | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), 'utf8')) as VaizerCatalog;
    if (!Array.isArray(c.skills)) return null;
    return { ...c, source: 'cached' };
  } catch {
    return null;
  }
}

function validSkill(s: unknown): s is VaizerCatalogSkill {
  const o = s as VaizerCatalogSkill;
  return (
    !!o &&
    typeof o.id === 'string' &&
    typeof o.slug === 'string' &&
    /^[a-z0-9-]+$/.test(o.slug) &&
    typeof o.description === 'string' &&
    (o.tier === 'nekko-official' || o.tier === 'community')
  );
}

/**
 * The Vaizer catalog. Without `refresh` this never touches the network:
 * last cached live fetch if present, else the bundled snapshot. With
 * `refresh` it fetches catalog.json from the Vaizer repo (falling back to
 * cache/snapshot on failure).
 */
export async function getVaizerCatalog(refresh = false): Promise<VaizerCatalog> {
  if (!refresh) return readCache() ?? VAIZER_SNAPSHOT;
  try {
    const res = await fetch(VAIZER_CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as { marketplace?: string; addCommand?: string; skills?: unknown[] };
    const skills = (raw.skills ?? []).filter(validSkill);
    if (skills.length === 0) throw new Error('Catalog had no valid skills.');
    const catalog: VaizerCatalog = {
      marketplace: raw.marketplace ?? 'vaizer',
      addCommand: raw.addCommand,
      skills,
      source: 'live',
      fetchedAt: Date.now(),
    };
    writeFileSync(cacheFile(), JSON.stringify(catalog, null, 2), 'utf8');
    return catalog;
  } catch {
    return readCache() ?? VAIZER_SNAPSHOT;
  }
}

/**
 * Fetch a Vaizer skill's verbatim SKILL.md (used at install time).
 *
 * Tries the current bundled-plugin path first, then the pre-2026-08-28
 * per-skill path. Keeping both means the marketplace restructure does not
 * decide whether an install gets the real skill or just the catalog summary,
 * whichever side is updated first.
 */
export async function getVaizerSkillMd(slug: string): Promise<string | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  for (const url of [vaizerSkillMdUrl(slug), vaizerLegacySkillMdUrl(slug)]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().length > 0) return text;
    } catch {
      // Try the next candidate; a network failure on one is not a verdict.
    }
  }
  return null;
}

/**
 * A live catalog refresh for the update checks: from the engine daemon when
 * it owns the catalog (it writes vaizer.json then), else here.
 */
export async function refreshVaizerCatalog(): Promise<VaizerCatalog> {
  const daemon = daemonCall();
  if (daemon && (await daemonOwns(daemon, 'vaizer:catalog'))) return daemon<VaizerCatalog>('vaizer:catalog', true);
  return getVaizerCatalog(true);
}
