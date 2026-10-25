/** Green, matching the on state of a toggle; BGRA because that is what `toBitmap` returns. */
export const RUNNER_DOT_BGRA = [0x58, 0xd1, 0x30, 0xff] as const;

/**
 * The CI runner badge on the tray icon: a copy of `bgra` with a filled circle
 * (diameter 40% of the width) in the bottom-right corner and a 1 px transparent
 * ring that keeps it readable against the icon. Other pixels are unchanged.
 */
export function paintDot(bgra: Buffer, width: number, height: number, color: readonly number[]): Buffer {
  const out = Buffer.from(bgra);
  const r = Math.round(width * 0.4) / 2;
  const cx = width - r, cy = height - r;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 1) continue;
      const i = (y * width + x) * 4;
      if (d <= r) out.set(color, i); else out.fill(0, i, i + 4);
    }
  }
  return out;
}
