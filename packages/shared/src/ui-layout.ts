/*
 * Layout and customization documents (spec desktop/customizable-ui). A layout
 * names which surfaces fill each slot; Simple and Expert are the official ones.
 * Customizations are one person's preferences on top: what shows, where things
 * were moved, theme, nav and which mods are on. Parsers never throw; bad fields
 * fall back to defaults so a damaged document can never blank the app.
 */

/** Same values as Simple mode's SimpleVisibility: both modes, Expert only, or neither. */
export type SlotVisibility = 'show' | 'expert' | 'hide';

export interface LayoutDoc {
  id: string;
  name: string;
  /** Slot id to the surface ids it holds, in order. */
  slots: Record<string, string[]>;
  visibility: Record<string, SlotVisibility>;
  board?: { arrangement?: string; zones?: number };
  /** A theme preset id, or null to use the person's theme. */
  theme: string | null;
}

/** Where a person moved a surface: a slot in any layout, or in one layout only. */
export type Placement = string | { slot: string; layout?: string };

export interface Customizations {
  format: 1;
  layout: string;
  visibility: Record<string, SlotVisibility>;
  nav: { order: string[]; hidden: string[] };
  theme: { preset: string | null; accent: string | null; accent2: string | null; fontSans: string | null; fontMono: string | null; textScale: number };
  board: { arrangement?: string };
  placements: Record<string, Placement>;
  mods: Record<string, { enabled: boolean }>;
  /** Top-level fields this device keeps to itself instead of following sync. */
  deviceOnly: Array<keyof Omit<Customizations, 'format' | 'deviceOnly'>>;
}

const VIS = new Set<string>(['show', 'expert', 'hide']);
const SYNCED_FIELDS = ['layout', 'visibility', 'nav', 'theme', 'board', 'placements', 'mods'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => str(x)) : []);
const json = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};
// Assigning a "__proto__" key on a plain object would set its prototype, so collect into a prototype-free one.
const record = <T>(v: unknown, keep: (x: unknown) => x is T): Record<string, T> => {
  const out: Record<string, T> = Object.create(null);
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (str(k) && keep(x)) out[k] = x;
  return { ...out };
};
const isVis = (x: unknown): x is SlotVisibility => typeof x === 'string' && VIS.has(x);
const isPlacement = (x: unknown): x is Placement => str(x, 64) || (isObj(x) && str(x.slot, 64) && (x.layout === undefined || str(x.layout, 128)));

export function parseLayoutDoc(raw: unknown): LayoutDoc | null {
  const v = json(raw);
  if (!isObj(v) || !str(v.id, 128) || !str(v.name) || !isObj(v.slots)) return null;
  const slots = record(v.slots, Array.isArray);
  for (const k of Object.keys(slots)) slots[k] = strings(slots[k]);
  const doc: LayoutDoc = { id: v.id, name: v.name, slots, visibility: record(v.visibility, isVis), theme: str(v.theme) ? v.theme : null };
  if (isObj(v.board)) {
    doc.board = {};
    if (str(v.board.arrangement, 32)) doc.board.arrangement = v.board.arrangement;
    if (Number.isInteger(v.board.zones) && (v.board.zones as number) >= 1 && (v.board.zones as number) <= 64) doc.board.zones = v.board.zones as number;
  }
  return doc;
}

export function parseCustomizations(raw: unknown): Customizations {
  const v = json(raw);
  const c = isObj(v) ? v : {};
  const theme = isObj(c.theme) ? c.theme : {};
  const nav = isObj(c.nav) ? c.nav : {};
  const orNull = (x: unknown) => (str(x) ? x : null);
  const scale = typeof theme.textScale === 'number' && theme.textScale >= 0.75 && theme.textScale <= 1.5 ? theme.textScale : 1;
  return {
    format: 1,
    layout: str(c.layout, 128) ? c.layout : 'nekko.simple',
    visibility: record(c.visibility, isVis),
    nav: { order: strings(nav.order), hidden: strings(nav.hidden) },
    theme: { preset: orNull(theme.preset), accent: orNull(theme.accent), accent2: orNull(theme.accent2), fontSans: orNull(theme.fontSans), fontMono: orNull(theme.fontMono), textScale: scale },
    board: isObj(c.board) && str(c.board.arrangement, 32) ? { arrangement: c.board.arrangement } : {},
    placements: record(c.placements, isPlacement),
    mods: record(c.mods, (x): x is { enabled: boolean } => isObj(x) && typeof x.enabled === 'boolean'),
    deviceOnly: strings(c.deviceOnly).filter((f): f is (typeof SYNCED_FIELDS)[number] => (SYNCED_FIELDS as readonly string[]).includes(f)),
  };
}

/**
 * What each slot shows: the layout's contents, then mod default placements,
 * then the person's placements. A surface sits in one slot at a time. A
 * placement the registry refuses, or naming a slot or surface that does not
 * exist, is ignored here and left in the document, so it returns if they do.
 */
export function resolveSlots(
  layout: LayoutDoc,
  opts: { modDefaults?: Record<string, string>; placements?: Record<string, Placement>; allowed: (surface: string, slot: string) => boolean },
): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  const where = new Map<string, string>();
  for (const [slot, list] of Object.entries(layout.slots)) {
    out[slot] = [];
    for (const s of list) if (!where.has(s)) { where.set(s, slot); out[slot].push(s); }
  }
  const move = (surface: string, slot: string) => {
    if (!Object.hasOwn(out, slot) || !opts.allowed(surface, slot)) return;
    const from = where.get(surface);
    if (from === slot) return;
    if (from) out[from] = out[from].filter((s) => s !== surface);
    out[slot].push(surface);
    where.set(surface, slot);
  };
  for (const [surface, slot] of Object.entries(opts.modDefaults ?? {})) if (!where.has(surface)) move(surface, slot);
  for (const [surface, p] of Object.entries(opts.placements ?? {})) {
    const slot = typeof p === 'string' ? p : p.layout === undefined || p.layout === layout.id ? p.slot : null;
    // Only surfaces the layout or a mod put somewhere exist on this screen.
    if (slot && where.has(surface)) move(surface, slot);
  }
  return { ...out };
}
