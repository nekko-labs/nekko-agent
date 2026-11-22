import { useEffect, useId, useState } from 'react';
import { NekkoCloudMarkPaths } from './NekkoCloudMark.js';

/** Which picture the walkthrough shows; one drawing that morphs between them. */
export type WelcomeScene = 'welcome' | 'account' | 'browser' | 'code' | 'in' | 'plan' | 'sync' | 'done';

/** The links from each device up to the mark, and the packets that run along them. */
export const SCENE_LINKS = [
  'M48 104 C 48 80 140 78 162 62',
  'M128 100 C 128 84 160 78 172 63',
  'M232 100 C 232 84 200 78 188 63',
  'M312 104 C 312 80 220 78 198 62',
] as const;

/**
 * The picture at the top of the Nekko Cloud walkthrough (#3187, v2 in #3190,
 * nekko-designs/cloud-welcome-walkthrough-design-v2.html): a laptop, a
 * desktop, a phone and a tablet kept in step through the Nekko Cloud mark,
 * end-to-end encrypted. Every scene draws the same parts; cloud.css moves,
 * shows and hides them per scene, so going from one step to the next plays as
 * one continuous motion.
 */
export function CloudWelcomeScene({ scene }: { scene: WelcomeScene }) {
  const id = useId().replace(/:/g, '');
  const glow = `cw-glow-${id}`;
  const prism = `cw-prism-${id}`;
  // Mount on the account layout and move to the real scene a frame later, so the first picture
  // plays its entrance instead of appearing already in place.
  const [shown, setShown] = useState<WelcomeScene>(scene === 'welcome' || scene === 'done' || scene === 'sync' ? scene : 'account');
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(scene));
    return () => cancelAnimationFrame(raf);
  }, [scene]);

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
      <circle className="ring" cx="180" cy="80" r="44" stroke={`url(#${prism})`} />
      {SCENE_LINKS.map((d) => <path key={d} className="link" d={d} />)}
      <g className="g-pk">
        {SCENE_LINKS.map((_, i) => <circle key={i} className={`pk p${i + 1}`} r="2.4" fill={`url(#${prism})`} />)}
      </g>
      <g className="dev d1">
        <rect className="body" x="20" y="104" width="56" height="34" rx="4" />
        <path className="body" d="M12 141 H84 L79 146 H17 Z" />
        <rect className="b" x="27" y="111" width="24" height="5" rx="2.5" />
        <rect className="b you" x="40" y="120" width="28" height="5" rx="2.5" />
        <rect className="b" x="27" y="129" width="18" height="5" rx="2.5" />
        <circle className="ok" cx="76" cy="104" r="4.5" />
      </g>
      <g className="dev d2">
        <rect className="body" x="100" y="100" width="56" height="38" rx="4" />
        <rect className="body" x="124" y="138" width="8" height="4" />
        <rect className="body" x="116" y="142" width="24" height="3" rx="1.5" />
        <rect className="b" x="107" y="107" width="26" height="5" rx="2.5" />
        <rect className="b you" x="122" y="116" width="27" height="5" rx="2.5" />
        <rect className="b" x="107" y="125" width="20" height="5" rx="2.5" />
        <circle className="ok" cx="156" cy="100" r="4.5" />
      </g>
      <g className="dev d3">
        <rect className="body" x="219" y="98" width="26" height="48" rx="6" />
        <rect className="b" x="227" y="101.5" width="10" height="2.5" rx="1.25" />
        <rect className="b" x="223" y="109" width="14" height="4" rx="2" />
        <rect className="b you" x="227" y="116" width="14" height="4" rx="2" />
        <rect className="b" x="223" y="123" width="11" height="4" rx="2" />
        <circle className="ok" cx="245" cy="98" r="4.5" />
      </g>
      <g className="dev d4">
        <rect className="body" x="284" y="104" width="56" height="40" rx="6" />
        <rect className="b" x="291" y="111" width="24" height="5" rx="2.5" />
        <rect className="b you" x="306" y="120" width="27" height="5" rx="2.5" />
        <rect className="b" x="291" y="129" width="18" height="5" rx="2.5" />
        <circle className="ok" cx="340" cy="104" r="4.5" />
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
      <path className="blink" d="M152 80 Q 198 56 242 72" />
      <g className="g-blink"><circle className="blinkpk" r="2.4" /></g>
      <g className="mail">
        <rect x="228" y="44" width="36" height="25" rx="4" />
        <path className="flap" d="M230 47 L246 59 L262 47" />
        <circle className="seal" cx="246" cy="59" r="3" />
      </g>
      <g className="mark">
        <g className="mark-in">
          <circle cx="180" cy="80" r="64" fill={`url(#${glow})`} />
          <g transform="translate(148 56)">
            <NekkoCloudMarkPaths>
              <g className="badge lock">
                <circle className="lockb" cx="56" cy="40" r="8" />
                <path className="lockg" d="M53 39.5 v-2 a3 3 0 0 1 6 0 v2" />
                <rect className="lockf" x="51.5" y="39" width="9" height="6.5" rx="1.5" />
              </g>
              <g className="badge ok">
                <circle className="checkb" cx="56" cy="40" r="8" />
                <path className="checkg" d="M52.2 40.3 l2.6 2.6 l5 -5.4" />
              </g>
            </NekkoCloudMarkPaths>
          </g>
        </g>
      </g>
    </svg>
  );
}
