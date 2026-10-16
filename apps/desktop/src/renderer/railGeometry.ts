export interface RailGeometryInput {
  railHeight: number;
  groupTop: number;
  groupHeight: number;
  /** Width of the expanded panel, tail included. */
  bodyWidth?: number;
  /** Width of the collapsed (icon-only) panel. */
  restWidth?: number;
}

type Pt = [number, number];

/** Corner radius for every bend of the outline. */
export const RAIL_CORNER = 16;
/** Clear space between the icon rows and the start of either shoulder. */
export const RAIL_ROW_CLEARANCE = 10;

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One outline as an SVG path: each tail ends in a concave curve that sweeps
 * into x=0, and every bend between is rounded. Rest and open outlines share
 * the same command sequence, so CSS can interpolate `d` between them.
 */
function outline(tip: number, mid: Pt[], bottom: number, radius: number): string {
  const upper = mid;
  const lower = [...mid].reverse().map(([x, y]): Pt => [x, bottom + tip - y]);
  const first = upper[0];
  const last = lower[lower.length - 1];
  const cmd: string[] = [`M0,${r1(tip)}`];
  // Concave tip: bows toward the left edge, so the tail flares into the wall.
  // The concave sweep stops short of the far edge, which then rounds down.
  const er = Math.min(radius, first[0] / 2);
  cmd.push(`Q0,${r1(first[1])} ${r1(first[0] - er)},${r1(first[1])}`);
  cmd.push(`Q${r1(first[0])},${r1(first[1])} ${r1(first[0])},${r1(first[1] + er)}`);
  const corners = [...upper, ...lower];
  for (let i = 1; i < corners.length - 1; i++) {
    const [px, py] = corners[i - 1];
    const [x, y] = corners[i];
    const [nx, ny] = corners[i + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a: Pt = inLen ? [x - ((x - px) / inLen) * r, y - ((y - py) / inLen) * r] : [x, y];
    const b: Pt = outLen ? [x + ((nx - x) / outLen) * r, y + ((ny - y) / outLen) * r] : [x, y];
    cmd.push(`L${r1(a[0])},${r1(a[1])}`, `Q${r1(x)},${r1(y)} ${r1(b[0])},${r1(b[1])}`);
  }
  cmd.push(`L${r1(last[0])},${r1(last[1] - er)}`);
  cmd.push(`Q${r1(last[0])},${r1(last[1])} ${r1(last[0] - er)},${r1(last[1])}`);
  cmd.push(`Q0,${r1(last[1])} 0,${r1(bottom)}`);
  cmd.push('Z');
  return cmd.join(' ');
}

/** Coordinates are rail-local. Only the decoration grows; the menu never moves.
 * Both shoulders start beyond the icon rows and narrow into matching tails.
 * The menu stays fixed while the expanded body and its tails widen together. */
export function railGeometry({ railHeight, groupTop, groupHeight, bodyWidth = 198, restWidth = 52 }: RailGeometryInput) {
  const height = Math.max(0, Number.isFinite(railHeight) ? railHeight : 0);
  const top = Math.min(height, Math.max(0, Number.isFinite(groupTop) ? groupTop : 0));
  const bottom = Math.min(height, top + Math.max(0, Number.isFinite(groupHeight) ? groupHeight : 0));
  const width = Math.max(0, Number.isFinite(bodyWidth) ? bodyWidth : 198);
  const rest = Math.min(width, Math.max(0, Number.isFinite(restWidth) ? restWidth : 52));
  const extension = Math.max(0, Math.min(top, height - bottom) - 2);
  // Short windows compress the vertical segments without moving the menu.
  const scale = Math.min(1, extension / 240);
  const clearance = Math.min(RAIL_ROW_CLEARANCE, extension / 4);
  const shoulder = 56 * scale;
  const concave = 28 * scale;
  const tipY = top - extension;
  const endY = top + bottom - tipY;
  // Mirror the body-to-tail shoulder above and below the destination rows.
  const station = (w: number, b: number): Pt[] => [
    [w, tipY + concave],
    [w, top - clearance - shoulder],
    [b, top - clearance],
    [b, top + (bottom - top) / 2],
  ];
  const restPts = station(rest / 2, rest);
  const openPts = station(rest, width);
  const radius = RAIL_CORNER;
  const restPath = outline(tipY, restPts, endY, radius);
  const openPath = outline(tipY, openPts, endY, radius);
  const mirror = (pts: Pt[]) => [...pts, ...[...pts].reverse().map(([x, y]): Pt => [x, endY + tipY - y])];
  return { width, height, top, bottom, extension, rest: mirror(restPts), open: mirror(openPts), restPath, openPath };
}
