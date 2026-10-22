import { getMarketSkill, vaizerToMarketSkill } from '@nekko-agent/shared';
import type { MarketplaceSkill, VaizerCatalogSkill } from '@nekko-agent/shared';
import type { Client } from './lib.js';

/** The subset of the client this module needs, so tests can pass a stub. */
export type SkillResolverClient = Pick<Client, 'vaizerCatalog' | 'vaizerSkillMd'>;

/**
 * Work out what `nekko-agent skills install <id>` should hand the host.
 *
 * Built-in catalog skills resolve host-side from their id alone. Vaizer skills
 * do not: `install` in `crates/nekko-workspace/src/skills.rs` accepts them only as
 * a `payload` snapshot, which the desktop's Vaizer shelf passes and the CLI
 * never did. That is why every `nekko-agent skills install <vaizer-skill>` failed
 * with "Unknown skill." even though the shelf installed the same skill fine.
 *
 * Accepts the friendly slug (`nyaa`) as well as the canonical catalog id
 * (`vaizer-nyaa`). The slug is what vaizer.app publishes, so it has to work.
 */
export async function resolveInstall(
  client: SkillResolverClient,
  idOrSlug: string,
): Promise<{ skillId: string; payload?: MarketplaceSkill }> {
  // Built-in skills already resolve from the id; passing a payload would only
  // shadow the catalog entry.
  if (getMarketSkill(idOrSlug)) return { skillId: idOrSlug };

  const entry = await findVaizerEntry(client, idOrSlug);
  // Not ours to resolve. Hand the id through unchanged and let the host give
  // its own "Unknown skill." rather than inventing a different error here.
  if (!entry) return { skillId: idOrSlug };

  // Install the real, current SKILL.md when the network allows; the catalog
  // summary is the offline fallback, matching what the desktop shelf does.
  const md = await client.vaizerSkillMd(entry.slug).catch(() => null);
  const payload = vaizerToMarketSkill(entry, md ?? undefined);
  return { skillId: payload.id, payload };
}

async function findVaizerEntry(
  client: SkillResolverClient,
  idOrSlug: string,
): Promise<VaizerCatalogSkill | undefined> {
  // `vaizerToMarketSkill` namespaces ids as `vaizer-<slug>`, so accept either.
  const wanted = idOrSlug.replace(/^vaizer-/, '');
  // `refresh` still falls back to cache then the bundled snapshot, so this
  // stays usable offline; it just prefers a catalog that knows about skills
  // published since this build.
  const catalog = await client.vaizerCatalog(true).catch(() => null);
  return catalog?.skills.find((s) => s.slug === wanted || s.id === wanted);
}
