export interface RailGeometryInput {
  railHeight: number;
  groupTop: number;
  groupHeight: number;
  /** Width of the expanded rail. */
  bodyWidth?: number;
  /** Width of the rail beside the icon rows at rest. */
  restWidth?: number;
}

/** Width of the hairline the rail starts and ends as. */
export const RAIL_TIP = 3;
/** Gap between the rail's top (or bottom) and the hairline's end. */
export const RAIL_TIP_INSET = 4;
/** Clear space between the icon rows and the end of each swoop. */
export const RAIL_ROW_CLEARANCE = 10;
/** Corner radius of the open column. */
export const RAIL_OPEN_RADIUS = 20;
/** Shortest the lower swoop may be; it otherwise matches the upper one. */
export const RAIL_MIN_LOWER_SWOOP = 120;
/** How long each swoop stays thin before it swells (0.5 = a plain S). */
const SWOOP = 0.62;

const r1 = (n: number) => Math.round(n * 10) / 10;
const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

/**
 * One closed outline against the wall (x = 0): a rounded end at the top,
 * a swoop from `tip` out to `body`, a straight run beside the rows, a
 * matching swoop back to `tip`, a hairline on down, and a rounded end.
 * Rest and open use the same commands, so CSS can interpolate `d`.
 */
function outline(y0: number, y1: number, swellTop: number, swellBottom: number, tip: number, body: number, corner: number): string {
  const a = y0 + corner;
  const b = y1 - corner;
  const upLen = Math.max(0, swellTop - a);
  // The rows sit high, so the lower swoop mirrors the upper one, then a hairline runs on.
  const downLen = Math.min(Math.max(0, b - swellBottom), Math.max(upLen, RAIL_MIN_LOWER_SWOOP));
  const up = upLen * SWOOP;
  const down = downLen * SWOOP;
  const tail = swellBottom + downLen;
  return [
    `M0,${r1(y0)}`,
    `L${r1(tip - corner)},${r1(y0)}`,
    `Q${r1(tip)},${r1(y0)} ${r1(tip)},${r1(a)}`,
    `C${r1(tip)},${r1(a + up)} ${r1(body)},${r1(swellTop - up)} ${r1(body)},${r1(swellTop)}`,
    `L${r1(body)},${r1(swellBottom)}`,
    `C${r1(body)},${r1(swellBottom + down)} ${r1(tip)},${r1(tail - down)} ${r1(tip)},${r1(tail)}`,
    `L${r1(tip)},${r1(b)}`,
    `Q${r1(tip)},${r1(y1)} ${r1(tip - corner)},${r1(y1)}`,
    `L0,${r1(y1)}`,
    'Z',
  ].join(' ');
}

/** Coordinates are rail-local; the menu never moves, only the outline does.
 * At rest the outline is a hairline near the top of the rail that swoops out
 * to the icon column and back. Open, every point moves to the same x, so the
 * whole rail becomes one even column. */
export function railGeometry({ railHeight, groupTop, groupHeight, bodyWidth = 198, restWidth = 52 }: RailGeometryInput) {
  const height = Math.max(0, finite(railHeight, 0));
  const top = Math.min(height, Math.max(0, finite(groupTop, 0)));
  const bottom = Math.min(height, top + Math.max(0, finite(groupHeight, 0)));
  const width = Math.max(0, finite(bodyWidth, 198));
  const rest = Math.min(width, Math.max(RAIL_TIP, finite(restWidth, 52)));
  const y0 = Math.min(RAIL_TIP_INSET, top);
  const y1 = Math.max(bottom, height - RAIL_TIP_INSET);
  const swellTop = Math.max(y0, top - RAIL_ROW_CLEARANCE);
  const swellBottom = Math.min(y1, bottom + RAIL_ROW_CLEARANCE);
  const radius = Math.max(0, Math.min(RAIL_OPEN_RADIUS, (swellTop - y0) / 2, (y1 - swellBottom) / 2, width / 2));
  const tipCorner = Math.min(RAIL_TIP, radius);
  const restPath = outline(y0, y1, swellTop, swellBottom, RAIL_TIP, rest, tipCorner);
  // Keep vertical anchors identical: the lower tail must widen with the body,
  // not travel vertically because the open corners use a different radius.
  const openPath = outline(y0, y1, swellTop, swellBottom, width, width, tipCorner);
  return { width, height, top, bottom, y0, y1, swellTop, swellBottom, restPath, openPath };
}
