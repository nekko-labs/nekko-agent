import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A hue/saturation color wheel with a lightness slider, for picking an accent
 * without leaving the app. The disc is a conic hue gradient under a radial
 * white wash, so angle reads as hue and distance from the center as saturation;
 * lightness is the separate track below.
 *
 * Values cross the boundary as 6-digit hex so callers can hand them straight to
 * a CSS custom property.
 */
export function ColorWheel({
  value,
  onChange,
  size = 132,
  label,
}: {
  value: string;
  onChange: (hex: string) => void;
  /** Disc diameter in px. */
  size?: number;
  /** Accessible name for the disc (the picker says which color it edits). */
  label?: string;
}) {
  const discRef = useRef<HTMLDivElement>(null);
  const [h, s, l] = hexToHsl(value);
  // Dragging past the rim should keep tracking the pointer, so the whole
  // gesture lives on the window rather than the disc.
  const [dragging, setDragging] = useState(false);

  const pick = useCallback(
    (clientX: number, clientY: number) => {
      const disc = discRef.current;
      if (!disc) return;
      const rect = disc.getBoundingClientRect();
      const radius = rect.width / 2;
      const dx = clientX - (rect.left + radius);
      const dy = clientY - (rect.top + radius);
      // Angle 0 points up and runs clockwise, matching the conic gradient.
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      const hue = (angle + 360) % 360;
      const sat = Math.min(1, Math.hypot(dx, dy) / radius) * 100;
      onChange(hslToHex(hue, sat, l));
    },
    [l, onChange],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => pick(e.clientX, e.clientY);
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, pick]);

  // Knob position: hue around the rim, saturation out from the center.
  const radius = size / 2;
  const knobAngle = ((h - 90) * Math.PI) / 180;
  const knobDist = (s / 100) * radius;
  const knobX = radius + Math.cos(knobAngle) * knobDist;
  const knobY = radius + Math.sin(knobAngle) * knobDist;

  /** Arrow keys nudge hue; shift-arrows nudge saturation, so the wheel is usable without a pointer. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 4 : 6;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) onChange(hslToHex(h, clamp(s + dir * step, 0, 100), l));
      else onChange(hslToHex((h + dir * step + 360) % 360, s, l));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      onChange(hslToHex(h, s, clamp(l + dir * 3, 0, 100)));
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: size }}>
      <div
        ref={discRef}
        role="slider"
        tabIndex={0}
        aria-label={label ?? 'Color wheel'}
        aria-valuetext={value}
        aria-valuenow={Math.round(h)}
        aria-valuemin={0}
        aria-valuemax={360}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          setDragging(true);
          pick(e.clientX, e.clientY);
        }}
        className="relative cursor-crosshair rounded-full border border-line outline-none focus-visible:ring-2"
        style={{
          width: size,
          height: size,
          // Hue around, saturation outward; the lightness track below does the rest.
          background: `
            radial-gradient(circle at 50% 50%, #fff 0%, rgba(255, 255, 255, 0) 70%),
            conic-gradient(from 0deg,
              hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%),
              hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))
          `,
          // Match the disc to the chosen lightness so the knob sits on its color.
          filter: `brightness(${0.45 + (l / 100) * 1.1})`,
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute h-4 w-4 rounded-full border-2 border-white shadow-(--shadow-md)"
          style={{
            left: knobX,
            top: knobY,
            transform: 'translate(-50%, -50%)',
            background: value,
            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.45)',
          }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(l)}
        aria-label={label ? `${label} lightness` : 'Lightness'}
        onChange={(e) => onChange(hslToHex(h, s, Number(e.target.value)))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, hsl(${h} ${s}% 4%), hsl(${h} ${s}% 50%), hsl(${h} ${s}% 96%))`,
        }}
      />
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Parse `#rgb` or `#rrggbb` into `[h, s, l]` (degrees, percent, percent). */
export function hexToHsl(hex: string): [number, number, number] {
  const clean = (hex ?? '').replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 50];
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = h * 60;
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}

/** Render `[h, s, l]` as a 6-digit hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = clamp(s, 0, 100) / 100;
  const lum = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lum - c / 2;
  const to255 = (v: number) =>
    Math.round(clamp((v + m) * 255, 0, 255))
      .toString(16)
      .padStart(2, '0');
  return `#${to255(r1)}${to255(g1)}${to255(b1)}`;
}
