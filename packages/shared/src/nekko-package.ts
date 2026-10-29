/*
 * The .nekko package (spec desktop/customizable-ui, decision 0032): a plain zip
 * with nekko.json at its root, carrying a customization, a mod or a layout. The
 * published schema (packages/shared/schemas/nekko-package-1.json) describes the
 * same manifest for authors; this parser is what the app trusts. Nothing here
 * throws: a bad manifest is a list of plain-language errors.
 */

export type PackageKind = 'customization' | 'mod' | 'layout';
export type PackagePlatform = 'desktop' | 'phone';

export const PACKAGE_KINDS: readonly PackageKind[] = ['customization', 'mod', 'layout'];

export const MOD_PERMISSIONS = [
  'chats:read',
  'chats:content',
  'chats:write',
  'hardware:read',
  'usage:read',
  'network',
  'files:read',
  'files:write',
  'tools:run',
] as const;
export type ModPermission = (typeof MOD_PERMISSIONS)[number];

export const PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PACKAGE_MANIFEST = 'nekko.json';
export const PACKAGE_SIGNATURES = 'SIGNATURES';

export interface Contribution { id: string; label: string; slots: string[]; entry: string }
export interface CommandContribution { id: string; label: string; shortcut: string | null }

export interface PackageContributions {
  panels: Contribution[];
  monitors: Contribution[];
  commands: CommandContribution[];
  /** ThemePreset-shaped objects, checked when applied. */
  themes: unknown[];
  /** Entry page of the mod's own settings section. */
  settings: string | null;
}

export interface PackageManifest {
  format: 1;
  kind: PackageKind;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  license?: string;
  engines?: { 'nekko-agent'?: string };
  platforms: PackagePlatform[];
  permissions: ModPermission[];
  network: { hosts: string[] };
  contributes: PackageContributions;
  main: string | null;
  layout: string | null;
  customization: Record<string, unknown> | null;
}

export type ManifestResult = { ok: true; manifest: PackageManifest } | { ok: false; errors: string[] };

const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const PART_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;
const MAX_TEXT = 10_000;
// Files that can run script; a customization carries none of them.
const CODE_FILE = /\.(m?js|cjs|html?|wasm|svg)$/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A relative path that stays inside the package: no leading slash, drive, backslash, or ".", ".." or empty segment. */
export function safePackagePath(p: unknown): p is string {
  // Control characters would also break the SIGNATURES listing's one-line-per-file format.
  if (typeof p !== 'string' || !p || p.length > 512 || p.startsWith('/') || p.includes('\\') || p.includes(':') || /[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export function parsePackageManifest(raw: unknown): ManifestResult {
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return { ok: false, errors: [`${PACKAGE_MANIFEST} is not valid JSON`] }; }
  }
  if (!isObj(v)) return { ok: false, errors: [`${PACKAGE_MANIFEST} must be a JSON object`] };
  const errors: string[] = [];

  const text = (key: string, required: boolean, max = MAX_TEXT): string | undefined => {
    const s = v[key];
    if (s === undefined || s === null) { if (required) errors.push(`"${key}" is required`); return undefined; }
    if (typeof s !== 'string' || !s.trim()) { errors.push(`"${key}" must be text`); return undefined; }
    if (s.length > max) { errors.push(`"${key}" is longer than ${max} characters`); return undefined; }
    return s;
  };
  const path = (where: string, p: unknown): string | null => {
    if (p === undefined || p === null) return null;
    if (!safePackagePath(p)) { errors.push(`${where} must be a path inside the package`); return null; }
    return p;
  };

  if (v.format !== 1) errors.push('"format" must be 1');
  const kind = v.kind;
  if (kind === undefined) errors.push('"kind" is required');
  else if (!PACKAGE_KINDS.includes(kind as PackageKind)) errors.push(`"kind" must be one of ${PACKAGE_KINDS.join(', ')}`);

  const id = text('id', true, 128);
  if (id !== undefined) {
    if (!ID.test(id)) errors.push('"id" must be reverse-DNS, like com.example.my-mod');
    else if (id.startsWith('nekko.')) errors.push('"id" may not start with "nekko.", which is reserved for the official layouts');
  }
  const name = text('name', true, 100);
  const version = text('version', true, 64);
  if (version !== undefined && !SEMVER.test(version)) errors.push('"version" must be semver, like 1.2.0');
  const description = text('description', false);
  const license = text('license', false, 100);

  let author: PackageManifest['author'];
  if (v.author !== undefined) {
    const a = v.author;
    if (!isObj(a) || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 200 || (a.url !== undefined && (typeof a.url !== 'string' || a.url.length > 500))) {
      errors.push('"author" must be { name, url? }');
    } else author = a.url === undefined ? { name: a.name } : { name: a.name, url: a.url as string };
  }

  let engines: PackageManifest['engines'];
  if (v.engines !== undefined) {
    const range = isObj(v.engines) ? v.engines['nekko-agent'] : null;
    if (!isObj(v.engines) || (range !== undefined && (typeof range !== 'string' || range.length > 100))) errors.push('"engines" must be { "nekko-agent": "<version range>" }');
    else engines = range === undefined ? {} : { 'nekko-agent': range as string };
  }

  let platforms: PackagePlatform[] = ['desktop'];
  if (v.platforms !== undefined) {
    const p = v.platforms;
    if (!Array.isArray(p) || !p.length || p.some((x) => x !== 'desktop' && x !== 'phone')) errors.push('"platforms" must list "desktop" and/or "phone"');
    else platforms = [...new Set(p as PackagePlatform[])];
  }

  let permissions: ModPermission[] = [];
  if (v.permissions !== undefined) {
    const p = v.permissions;
    if (!Array.isArray(p)) errors.push('"permissions" must be a list');
    else {
      const bad = p.filter((x) => !MOD_PERMISSIONS.includes(x as ModPermission));
      if (bad.length) errors.push(`unknown permissions: ${bad.map(String).join(', ')}`);
      else permissions = [...new Set(p as ModPermission[])];
    }
  }

  let hosts: string[] = [];
  let hostsBad = false;
  if (v.network !== undefined) {
    const h = isObj(v.network) ? v.network.hosts : undefined;
    hostsBad = !Array.isArray(h) || h.some((x) => typeof x !== 'string' || !HOST.test(x));
    if (hostsBad) errors.push('"network.hosts" must list host names, like api.example.com');
    else hosts = [...new Set(h as string[])];
  }
  if (permissions.includes('network') && !hosts.length && !hostsBad) errors.push('the "network" permission needs at least one host in "network.hosts"');
  if (hosts.length && !permissions.includes('network')) errors.push('"network.hosts" needs the "network" permission');

  const contributes: PackageContributions = { panels: [], monitors: [], commands: [], themes: [], settings: null };
  if (v.contributes !== undefined) {
    const c = v.contributes;
    if (!isObj(c)) errors.push('"contributes" must be an object');
    else {
      for (const key of ['panels', 'monitors'] as const) {
        const list = c[key] ?? [];
        if (!Array.isArray(list)) { errors.push(`"contributes.${key}" must be a list`); continue; }
        list.forEach((x, i) => {
          const where = `contributes.${key}[${i}]`;
          if (!isObj(x) || typeof x.id !== 'string' || !PART_ID.test(x.id) || typeof x.label !== 'string' || !x.label.trim() || x.label.length > 200
            || !Array.isArray(x.slots) || !x.slots.length || x.slots.some((s) => typeof s !== 'string' || s.length > 64)) {
            errors.push(`${where} must be { id, label, slots, entry }`);
            return;
          }
          const entry = path(`${where}.entry`, x.entry);
          if (entry === null) { if (x.entry === undefined) errors.push(`${where}.entry is required`); return; }
          contributes[key].push({ id: x.id, label: x.label, slots: [...(x.slots as string[])], entry });
        });
      }
      const commands = c.commands ?? [];
      if (!Array.isArray(commands)) errors.push('"contributes.commands" must be a list');
      else commands.forEach((x, i) => {
        if (!isObj(x) || typeof x.id !== 'string' || !PART_ID.test(x.id) || typeof x.label !== 'string' || !x.label.trim() || x.label.length > 200
          || (x.shortcut != null && (typeof x.shortcut !== 'string' || x.shortcut.length > 40))) {
          errors.push(`contributes.commands[${i}] must be { id, label, shortcut }`);
        } else contributes.commands.push({ id: x.id, label: x.label, shortcut: (x.shortcut as string | undefined) ?? null });
      });
      const themes = c.themes ?? [];
      if (!Array.isArray(themes) || themes.some((t) => !isObj(t))) errors.push('"contributes.themes" must be a list of themes');
      else contributes.themes = [...themes];
      contributes.settings = path('contributes.settings', c.settings);
    }
  }

  const main = path('"main"', v.main);
  const layout = path('"layout"', v.layout);
  let customization: Record<string, unknown> | null = null;
  if (v.customization !== undefined && v.customization !== null) {
    if (!isObj(v.customization)) errors.push('"customization" must be an object');
    else customization = v.customization;
  }

  if (kind === 'customization') {
    if (!customization) errors.push('a customization package needs "customization"');
    if (contributes.panels.length || contributes.monitors.length || contributes.commands.length || contributes.settings || main || layout || permissions.length) {
      errors.push('a customization package carries no code, contributions or permissions');
    }
  }
  if (kind === 'layout' && !layout) errors.push('a layout package needs "layout"');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      format: 1,
      kind: kind as PackageKind,
      id: id!,
      name: name!,
      version: version!,
      ...(description !== undefined && { description }),
      ...(author && { author }),
      ...(license !== undefined && { license }),
      ...(engines && { engines }),
      platforms,
      permissions,
      network: { hosts },
      contributes,
      main,
      layout,
      customization,
    },
  };
}

/** Problems with a package's zip entries, checked before anything is unpacked. Empty means fine. */
export function checkPackageEntries(entries: ReadonlyArray<{ path: string; size: number; symlink?: boolean }>, kind: PackageKind): string[] {
  const errors: string[] = [];
  let total = 0;
  for (const e of entries) {
    total += Math.max(0, e.size);
    if (e.symlink) errors.push(`${e.path} is a link, which packages may not contain`);
    else if (!safePackagePath(e.path)) errors.push(`${e.path} is not a path inside the package`);
    else if (kind === 'customization' && CODE_FILE.test(e.path)) errors.push(`${e.path} is code, which a customization may not contain`);
  }
  if (total > PACKAGE_MAX_BYTES) errors.push(`the package is larger than ${PACKAGE_MAX_BYTES / 1024 / 1024} MB`);
  if (!entries.some((e) => e.path === PACKAGE_MANIFEST)) errors.push(`${PACKAGE_MANIFEST} is missing`);
  return errors;
}
