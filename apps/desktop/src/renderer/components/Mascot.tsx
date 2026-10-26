import React, { useEffect, useState } from 'react';

export type MascotMood = 'idle' | 'waving' | 'thinking';

/** The app icon's wide cat head, drawn on a 32px grid. No shared SVG IDs. */
function PixelHead({ eyes = true }: { eyes?: boolean }) {
  return (
    <g data-part="pixel-head" strokeLinejoin="miter">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#101714" stroke="#f2f1e9" strokeWidth="2" />
      {eyes && <g data-part="pixel-eyes" fill="#f2f1e9">
        <path className="pixel-eyes-open" d="M11 15H13V18H11Z M20 15H22V18H20Z" />
        <path className="pixel-eyes-happy" d="M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z" />
        <path className="pixel-eyes-closed" d="M10 17H14V18H10Z M19 17H23V18H19Z" />
      </g>}
      <path className="pixel-mouth" d="M15 20H17V21H15Z" fill="#a7c8ac" />
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


/**
 * The hat is drawn at full size on the head's grid, then shrunk to 80% around
 * its brim and lifted so the brim sits on the crown between the ears rather
 * than over the forehead.
 */
const WIZARD_HAT_TRANSFORM = 'translate(16.5 9) scale(0.8) translate(-16.5 -12)';

export function NekkoAvatar({ size = 28, title, wizardHat = false, stationary = false, quiet = false, eyes = true }: { size?: number; title?: string; wizardHat?: boolean; stationary?: boolean; quiet?: boolean; eyes?: boolean }) {
  const hidden = usePageHidden();
  return (
    <svg className={`pixel-nekko${stationary ? ' pixel-stationary' : ''}${quiet ? ' pixel-quiet' : ''}${hidden ? ' pixel-paused' : ''}`} viewBox="0 0 32 32" width={size} height={size}
      shapeRendering="crispEdges" role={title ? 'img' : 'presentation'} aria-label={title}
      aria-hidden={title ? undefined : true} focusable="false">
      <PixelHead eyes={eyes} />
      {wizardHat && <g data-part="orange-wizard-hat" strokeLinejoin="miter" transform={WIZARD_HAT_TRANSFORM}>
        <polygon points="9,10 16,0 19,2 23,10" fill="#fb923c" stroke="#9a3412" strokeWidth="1" />
        <rect x="8" y="9" width="17" height="3" fill="#ea580c" stroke="#9a3412" strokeWidth="1" />
        <rect x="16" y="7" width="3" height="2" fill="#fde68a" />
      </g>}
    </svg>
  );
}

export function MiniNekko({ size = 18 }: { size?: number }) {
  return <span className="pixel-working inline-block shrink-0 align-middle" style={{ lineHeight: 0 }}><NekkoAvatar size={size} /></span>;
}

/** The corner mascot is the one place a seasonal theme dresses Nekko up (Spooky adds the wizard hat). */
export function Mascot({ mood, enabled, working = false, wizardHat = false }: { mood: MascotMood; enabled: boolean; working?: boolean; wizardHat?: boolean }) {
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
      <NekkoAvatar size={64} quiet={!working} stationary={working} wizardHat={wizardHat} />
    </button>
  );
}
