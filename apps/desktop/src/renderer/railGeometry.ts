export interface RailGeometryInput {
  railHeight: number;
  groupTop: number;
  groupHeight: number;
  /** Width of the expanded rail. */
  bodyWidth?: number;
  /** Width of the rail beside the icon rows at rest. */
  restWidth?: number;
}

/** Clear space between the icon rows and the end of each swoop. */
export const RAIL_ROW_CLEARANCE = 10;
/** Longest the upper taper may run before it meets the wall. */
export const RAIL_MAX_TAPER = 160;
/** Shortest the lower taper may be; it otherwise matches the upper one. */
export const RAIL_MIN_LOWER_SWOOP = 120;
/** How long each taper stays thin before it swells (0.5 = a plain S). */
const SWOOP = 0.62;

const r1 = (n: number) => Math.round(n * 10) / 10;
const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

/**
 * One closed outline against the wall (x = 0): a taper out of the wall to
 * `body`, a straight run beside the rows, and a matching taper back into the
 * wall. Nothing runs on past either taper, so the shape ends where it meets
 * the edge of the window. Rest and open use the same commands.
 */
function outline(y0: number, y1: number, swellTop: number, swellBottom: number, body: number): string {
  const up = (swellTop - y0) * SWOOP;
  const down = (y1 - swellBottom) * SWOOP;
  return [
    `M0,${r1(y0)}`,
    `C0,${r1(y0 + up)} ${r1(body)},${r1(swellTop - up)} ${r1(body)},${r1(swellTop)}`,
    `L${r1(body)},${r1(swellBottom)}`,
    `C${r1(body)},${r1(swellBottom + down)} 0,${r1(y1 - down)} 0,${r1(y1)}`,
    'Z',
  ].join(' ');
}

/** Coordinates are rail-local; the menu never moves, only the outline does.
 * At rest the outline tapers out of the wall above the icon column, runs
 * beside it, and tapers back into the wall below. `y0`/`y1` are where the
 * tapers meet the wall. Open, the body moves to the open width. */
export function railGeometry({ railHeight, groupTop, groupHeight, bodyWidth = 198, restWidth = 52 }: RailGeometryInput) {
  const height = Math.max(0, finite(railHeight, 0));
  const top = Math.min(height, Math.max(0, finite(groupTop, 0)));
  const bottom = Math.min(height, top + Math.max(0, finite(groupHeight, 0)));
  const width = Math.max(0, finite(bodyWidth, 198));
  const rest = Math.min(width, Math.max(0, finite(restWidth, 52)));
  const swellTop = Math.max(0, top - RAIL_ROW_CLEARANCE);
  const swellBottom = Math.max(swellTop, Math.min(height, bottom + RAIL_ROW_CLEARANCE));
  // The rows sit high, so the lower taper mirrors the upper one (at least
  // RAIL_MIN_LOWER_SWOOP long) wherever the rail has the room.
  const upLen = Math.min(swellTop, RAIL_MAX_TAPER);
  const downLen = Math.max(0, Math.min(height - swellBottom, Math.max(upLen, RAIL_MIN_LOWER_SWOOP)));
  const y0 = swellTop - upLen;
  const y1 = swellBottom + downLen;
  const restPath = outline(y0, y1, swellTop, swellBottom, rest);
  const openPath = outline(y0, y1, swellTop, swellBottom, width);
  return { width, height, top, bottom, y0, y1, swellTop, swellBottom, restPath, openPath };
}
