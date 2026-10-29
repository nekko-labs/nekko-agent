import React from 'react';
import { useStore } from '../store.js';
import { NekkoAvatar } from './Mascot.js';

/**
 * The empty wall's illustration: a wall with dashed window frames waiting to be
 * filled, and Nekko sitting under it. Special themes dress it up (Spooky adds
 * pumpkins, a bat and a cobweb; the wizard hat is the corner mascot's alone). Decorative only; colours come
 * from the theme so it reads in light and dark.
 */
export type WallEmptyVariant = 'default' | 'spooky';

export function wallEmptyVariant(preset: string | undefined): WallEmptyVariant {
  return preset === 'autumn' ? 'spooky' : 'default';
}

export function WallEmptyIllustration({ variant }: { variant?: WallEmptyVariant }) {
  const preset = useStore((s) => s.settings?.themePreset);
  const v = variant ?? wallEmptyVariant(preset);
  const spooky = v === 'spooky';
  return (
    <div className="wall-empty-art" data-variant={v} aria-hidden="true">
      <svg viewBox="0 0 240 150" width="240" height="150" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* The wall: three empty window frames. */}
        <rect x="20" y="14" width="200" height="104" rx="10" stroke="var(--line)" strokeWidth="1.5" />
        <rect x="32" y="26" width="104" height="80" rx="6" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="5 5" />
        <rect x="146" y="26" width="62" height="36" rx="6" stroke="var(--accent-2)" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="5 5" />
        <rect x="146" y="70" width="62" height="36" rx="6" stroke="var(--accent-2)" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="5 5" />
        {/* A plus in the big frame: something goes here. */}
        <path d="M84 58v16M76 66h16" stroke="var(--accent)" strokeWidth="2" />
        {/* The floor line Nekko sits on. */}
        <path d="M8 140h224" stroke="var(--line)" strokeWidth="1.5" />
        {spooky ? (
          <g data-part="spooky">
            {/* Cobweb in the wall's top-left corner. */}
            <g stroke="var(--ink-faint)" strokeWidth="1" strokeOpacity="0.7">
              <path d="M20 14l22 22M20 14v30M20 14h30" />
              <path d="M20 26q6 0 9 3q3 3 0 9M20 36q11 0 16 6M30 14q0 7 4 11q4 3 10 3" />
            </g>
            {/* A bat over the small frames. */}
            <path className="wall-empty-bat" d="M170 8q4-5 8 0q2-3 4 0q2-3 4 0q4-5 8 0q-5 1-8 6q-2-2-4-2q-2 0-4 2q-3-5-8-6z" fill="var(--ink-soft)" />
            {/* Pumpkins on the floor. */}
            <g transform="translate(176 118)">
              <path d="M12 3c-1-3 1-5 3-6" stroke="var(--success)" strokeWidth="2" />
              <ellipse cx="8" cy="13" rx="8" ry="9" fill="#f97316" />
              <ellipse cx="16" cy="13" rx="8" ry="9" fill="#f97316" />
              <ellipse cx="12" cy="13" rx="6" ry="9.5" fill="#fb923c" />
              <path d="M8 11l2 2-2 0zM16 11l-2 2 2 0zM8 17q4 3 8 0" stroke="#7c2d12" strokeWidth="1.2" fill="#7c2d12" />
            </g>
            <g transform="translate(204 128) scale(0.55)">
              <ellipse cx="8" cy="13" rx="8" ry="9" fill="#ea580c" />
              <ellipse cx="16" cy="13" rx="8" ry="9" fill="#ea580c" />
              <ellipse cx="12" cy="13" rx="6" ry="9.5" fill="#f97316" />
              <path d="M12 3c-1-3 1-5 3-6" stroke="var(--success)" strokeWidth="3" />
            </g>
          </g>
        ) : (
          <g data-part="default" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="1.5">
            {/* Sparkles: the wall is ready. */}
            <path d="M190 128v8M186 132h8" />
            <path d="M210 120v5M207.5 122.5h5" />
          </g>
        )}
      </svg>
      {/* Nekko is the same pixel cat as the app icon, sitting on the floor line. */}
      <span className="wall-empty-cat"><NekkoAvatar size={44} stationary quiet /></span>
    </div>
  );
}

/** An empty zone's placeholder: Nekko dozing until an agent arrives. Faded so the zone still reads as empty. */
export function ZoneEmptyIllustration() {
  return (
    <div className="wall-zone-art pixel-sleeping" aria-hidden="true">
      <svg viewBox="0 0 88 52" width="88" height="52" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 48h60" stroke="var(--line)" strokeWidth="1.5" />
        <g stroke="var(--accent)" strokeWidth="1.5">
          <path d="M64 20h5l-5 5h5" strokeOpacity="0.5" />
          <path d="M71 7h7l-7 7h7" strokeOpacity="0.8" />
        </g>
      </svg>
      <span className="wall-zone-art-cat"><NekkoAvatar size={36} stationary quiet /></span>
    </div>
  );
}
