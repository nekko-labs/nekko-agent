import { join } from 'node:path';
import { PACKAGE_MANIFEST, PACKAGE_SIGNATURES, safePackagePath, type PackageManifest } from '@nekko-agent/shared';

/*
 * The mod sandbox's outer walls (spec desktop/customizable-ui, decision 0032).
 * Mod surfaces load from nekko-mod://<id>/ into frames with an opaque origin;
 * these decide what that origin may load and which file a request reaches.
 */

export const MOD_SCHEME = 'nekko-mod';

const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;

/** The content policy for a mod's pages: its own files only, and the network only to declared hosts under the network permission. */
export function modCsp(manifest: Pick<PackageManifest, 'permissions' | 'network'>): string {
  const hosts = manifest.permissions.includes('network') ? manifest.network.hosts.filter((h) => HOST.test(h)) : [];
  const connect = hosts.length ? hosts.map((h) => `https://${h}`).join(' ') : "'none'";
  return `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connect}; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'`;
}

/** The file a nekko-mod:// request reaches under `root/<id>/`, or null for anything outside it or the package's own metadata. */
export function resolveModPath(root: string, url: string): string | null {
  let parsed: URL;
  let rel: string;
  try {
    parsed = new URL(url);
    rel = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MOD_SCHEME}:` || !ID.test(parsed.hostname) || !safePackagePath(rel)) return null;
  if (rel === PACKAGE_MANIFEST || rel === PACKAGE_SIGNATURES) return null;
  return join(root, parsed.hostname, ...rel.split('/'));
}
