import React, { useEffect, useState } from 'react';
import type { SeasonalHat } from '../seasonal.js';
import { SeasonalHatArt } from './SeasonalHat.js';

export type MascotMood = 'idle' | 'waving' | 'thinking';

/** The app icon's wide cat head, drawn on a 32px grid: brand plum, white line and eyes, light-plum mouth (spec/brand/colour-palette.md). No shared SVG IDs. */
export function PixelHead({ eyes = true, mouth = true, pupilOffset }: { eyes?: boolean; mouth?: boolean; pupilOffset?: { x: number; y: number } }) {
  // The eye group gets a per-render translate so the pupils can watch something
  // outside the SVG (e.g. the chat composer's caret); the opacity keyframes on
  // the child <path>s continue to blink and smile over it.
  const eyeTransform = pupilOffset ? `translate(${pupilOffset.x} ${pupilOffset.y})` : undefined;
  return (
    <g data-part="pixel-head" strokeLinejoin="miter">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#190019" stroke="#ffffff" strokeWidth="2" />
      {eyes && <g data-part="pixel-eyes" fill="#ffffff" transform={eyeTransform}>
        <path className="pixel-eyes-open" d="M11 15H13V18H11Z M20 15H22V18H20Z" />
        <path className="pixel-eyes-happy" d="M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z" />
        <path className="pixel-eyes-closed" d="M10 17H14V18H10Z M19 17H23V18H19Z" />
      </g>}
      {mouth && <path className="pixel-mouth" d="M15 20H17V21H15Z" fill="#c99bb3" />}
    </g>
  );
}

function usePageHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}


export const NekkoAvatar = React.forwardRef<SVGSVGElement, { size?: number; title?: string; hat?: SeasonalHat; stationary?: boolean; quiet?: boolean; eyes?: boolean; pupilOffset?: { x: number; y: number } }>(function NekkoAvatar(
  { size = 28, title, hat, stationary = false, quiet = false, eyes = true, pupilOffset },
  ref,
) {
  const hidden = usePageHidden();
  return (
    <svg ref={ref} className={`pixel-nekko${stationary ? ' pixel-stationary' : ''}${quiet ? ' pixel-quiet' : ''}${hidden ? ' pixel-paused' : ''}`} viewBox="0 0 32 32" width={size} height={size}
      shapeRendering="crispEdges" overflow={hat ? 'visible' : undefined} role={title ? 'img' : 'presentation'} aria-label={title}
      aria-hidden={title ? undefined : true} focusable="false">
      <PixelHead eyes={eyes} pupilOffset={pupilOffset} />
      {hat && <SeasonalHatArt hat={hat} />}
    </svg>
  );
});

export function MiniNekko({ size = 18 }: { size?: number }) {
  return <span className="pixel-working inline-block shrink-0 align-middle" style={{ lineHeight: 0 }}><NekkoAvatar size={size} /></span>;
}

/** The corner mascot can wear a seasonal theme's hat (Spooky's wizard hat, Winter's beanie). */
export function Mascot({ mood, enabled, working = false, hat }: { mood: MascotMood; enabled: boolean; working?: boolean; hat?: SeasonalHat }) {
  const [sleeping, setSleeping] = useState(false);
  const [greeting, setGreeting] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setSleeping(false);
      clearTimeout(timer);
      if (!working) timer = setTimeout(() => setSleeping(true), 60_000);
    };
    wake();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [enabled, working]);
  useEffect(() => {
    if (!greeting) return;
    const timer = setTimeout(() => setGreeting(false), 1200);
    return () => clearTimeout(timer);
  }, [greeting]);
  if (!enabled) return null;
  const pose = working ? 'working' : greeting || mood === 'waving' ? 'happy' : sleeping ? 'sleeping' : 'idle';
  return (
    // left-[11px]: the drawing's ink starts ~6px into its box and its feet sit
    // ~17px above the window edge, so this evens the gap on both sides.
    <button type="button" className={`pixel-mascot pixel-${pose} fixed bottom-2 left-[11px] z-40 flex w-16 select-none items-end justify-center`}
      data-mascot-pose={pose} aria-label={pose === 'working' ? 'Nekko is working' : 'Say hello to Nekko'}
      title={pose === 'sleeping' ? 'Nekko is sleeping' : 'Say hello to Nekko'}
      onClick={() => { setSleeping(false); setGreeting(true); }}>
      <NekkoAvatar size={64} quiet={!working} stationary={working} hat={hat} />
    </button>
  );
}
