import { useEffect, useId, useState } from 'react';
import { PixelHead } from '../Mascot.js';

/** Which picture the walkthrough shows; one drawing that morphs between them. */
export type WelcomeScene = 'welcome' | 'account' | 'browser' | 'code' | 'in' | 'plan' | 'sync' | 'done';

/**
 * The picture at the top of the Nekko Cloud walkthrough (#3187,
 * nekko-designs/cloud-welcome-walkthrough-design.html): your laptop and phone
 * kept in step through Nekko, end-to-end encrypted. Every scene draws the same
 * parts; cloud.css moves, shows and hides them per scene, so going from one
 * step to the next plays as one continuous motion.
 */
export function CloudWelcomeScene({ scene }: { scene: WelcomeScene }) {
  const id = useId().replace(/:/g, '');
  const glow = `cw-glow-${id}`;
  const prism = `cw-prism-${id}`;
  // Mount on the account layout and move to the real scene a frame later, so the first picture
  // plays its entrance instead of appearing already in place.
  const [shown, setShown] = useState<WelcomeScene>(scene === 'welcome' || scene === 'done' ? scene : 'account');
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(scene));
    return () => cancelAnimationFrame(raf);
  }, [scene]);
  const happy = shown === 'in' || shown === 'done';

  return (
    <svg className={`cw-s s-${shown}`} viewBox="0 0 360 160" aria-hidden="true" focusable="false" data-scene={shown}>
      <defs>
        <radialGradient id={glow}>
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={prism} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset=".45" stopColor="var(--accent-2)" />
          <stop offset=".62" className="cw-prism-3" />
          <stop offset=".8" className="cw-prism-4" />
          <stop offset="1" className="cw-prism-5" />
        </linearGradient>
      </defs>
      <circle className="glow" cx="180" cy="80" r="70" fill={`url(#${glow})`} />
      <circle className="orbit" cx="180" cy="80" r="42" />
      <circle className="ring" cx="180" cy="80" r="40" stroke={`url(#${prism})`} />
      <path className="arc" d="M100 74 Q 118 54 142 66" />
      <path className="arc" d="M218 66 Q 246 50 276 70" />
      <g className="g-pk">
        <circle className="pk l" r="2.6" fill={`url(#${prism})`} />
        <circle className="pk r" r="2.6" fill={`url(#${prism})`} />
      </g>
      <g className="g-sync">
        <rect className="plain" width="9" height="4" rx="2" />
        <rect className="plain b2" width="9" height="4" rx="2" />
        <rect className="plain b3" width="9" height="4" rx="2" />
        <rect className="cipher" width="6" height="6" rx="1.5" />
        <rect className="cipher b2" width="6" height="6" rx="1.5" />
        <rect className="cipher b3" width="6" height="6" rx="1.5" />
      </g>
      <g className="dev l">
        <rect className="body" x="34" y="60" width="62" height="40" rx="5" />
        <path className="body" d="M26 104 H104 L98 110 H32 Z" />
        <rect className="b" x="42" y="68" width="28" height="6" rx="3" />
        <rect className="b you" x="58" y="78" width="30" height="6" rx="3" />
        <rect className="b" x="42" y="88" width="22" height="6" rx="3" />
        <circle className="ok" cx="96" cy="60" r="5" />
      </g>
      <g className="dev r">
        <rect className="body" x="276" y="48" width="36" height="64" rx="8" />
        <rect className="b" x="288" y="52" width="12" height="3" rx="1.5" />
        <rect className="b" x="282" y="62" width="20" height="5" rx="2.5" />
        <rect className="b you" x="288" y="71" width="18" height="5" rx="2.5" />
        <rect className="b" x="282" y="80" width="16" height="5" rx="2.5" />
        <circle className="ok" cx="312" cy="48" r="5" />
      </g>
      <g className="cloud">
        <path d="M262 92 a16 16 0 0 1 4 -31 a22 22 0 0 1 41 -4 a17 17 0 0 1 9 35 Z" />
        <rect className="cl" x="276" y="70" width="8" height="8" rx="2" />
        <rect className="cl" x="288" y="70" width="8" height="8" rx="2" />
        <rect className="cl" x="300" y="70" width="8" height="8" rx="2" />
      </g>
      <g className="browser">
        <rect className="body" x="244" y="46" width="88" height="64" rx="8" />
        <circle className="bar" cx="254" cy="55" r="2" />
        <circle className="bar" cx="261" cy="55" r="2" />
        <circle className="bar" cx="268" cy="55" r="2" />
        <rect className="bar" x="256" y="70" width="44" height="4" rx="2" />
        <rect className="go" x="256" y="84" width="64" height="14" rx="7" />
        <rect className="gol" x="276" y="89.5" width="24" height="3" rx="1.5" />
      </g>
      <path className="link" d="M146 78 Q 196 52 242 72" />
      <g className="g-link"><circle className="linkpk" r="2.6" /></g>
      <g className="mail">
        <rect x="226" y="46" width="36" height="25" rx="4" />
        <path className="flap" d="M228 49 L244 61 L260 49" />
        <circle className="seal" cx="244" cy="61" r="3" />
      </g>
      <g className={`nekko${happy ? ' pixel-happy' : ''}`}>
        <g transform="translate(156 56) scale(1.5)" shapeRendering="crispEdges"><PixelHead /></g>
      </g>
      <g className="badge lock">
        <circle className="lockb" cx="205" cy="102" r="10" />
        <path className="lockg" d="M201.6 101 v-2.4 a3.4 3.4 0 0 1 6.8 0 V101" />
        <rect className="lockf" x="200" y="100.5" width="10" height="7" rx="1.6" />
      </g>
      <g className="badge ok">
        <circle className="checkb" cx="205" cy="102" r="10" />
        <path className="checkg" d="M200.5 102.2 l3 3 l5.6 -6" />
      </g>
    </svg>
  );
}
