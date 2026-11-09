import React from 'react';
import type { SeasonalHat } from '../seasonal.js';

/**
 * The wizard hat is drawn at full size on the head's grid, then shrunk to 80% around
 * its brim and lifted so the brim sits on the crown between the ears rather
 * than over the forehead.
 */
const WIZARD_HAT_TRANSFORM = 'translate(16.5 9) scale(0.8) translate(-16.5 -12)';

/*
 * Winter's knitted cat-ear beanie, on the head's 32-unit grid. It is a little
 * wider than the head and covers Nekko's own ears, bringing knitted ones of
 * its own: a snug rounded crown, ears growing out of it with pink insides,
 * V-stitch knit rows, and a cream ribbed brim that stops at y=13, above the
 * eyes (y=15). Chosen from a design round (spec/brand/winter-theme.md).
 */
const BEANIE = 'M3 12V7H4V2H5V0H6V-1H7V0H8V1H9V2H10V3H22V2H23V1H24V0H25V-1H26V0H27V2H28V7H29V12Z';
const BEANIE_EARS = 'M5 1H6V0H7V1H8V2H9V3H5Z M27 1H26V0H25V1H24V2H23V3H27Z';
const BEANIE_BRIM = 'M3 9H29V12H28V13H4V12H3Z';
/** Two staggered rows of V stitches across the crown. */
const BEANIE_KNIT = [[4.5, 6], [6.5, 7.5]].flatMap(([y, from]) => Array.from({ length: 7 }, (_, i) => `M${from + i * 3} ${y}l1 1 1-1`)).join('');
const BEANIE_RIBS = Array.from({ length: 12 }, (_, i) => `M${5 + i * 2} 10V12`).join('');
const SNOWFLAKE = 'M16.5 3.5V8.5M14 6H19M14.8 4.3l3.4 3.4M18.2 4.3l-3.4 3.4';

/**
 * A seasonal theme's hat, on the head's 32-unit grid. The wizard hat is
 * Spooky's; the knitted cat-ear beanie is Winter's, with a snowflake on the
 * front, which turns to a holly sprig on December 24 and 25 (seasonal.ts).
 */
export function SeasonalHatArt({ hat }: { hat: SeasonalHat }) {
  if (hat === 'wizard') return (
    <g data-part="orange-wizard-hat" strokeLinejoin="miter" transform={WIZARD_HAT_TRANSFORM}>
      <polygon points="9,10 16,0 19,2 23,10" fill="#fb923c" stroke="#9a3412" strokeWidth="1" />
      <rect x="8" y="9" width="17" height="3" fill="#ea580c" stroke="#9a3412" strokeWidth="1" />
      <rect x="16" y="7" width="3" height="2" fill="#fde68a" />
    </g>
  );
  return (
    <g data-part="winter-beanie" data-motif={hat === 'holly' ? 'holly' : 'snowflake'} strokeLinejoin="miter">
      <path d={BEANIE} fill="#c8475d" stroke="#5e1424" strokeWidth="1" />
      <path d={BEANIE_EARS} fill="#f4a9bb" />
      <path d={BEANIE_KNIT} stroke="#de7387" strokeWidth="0.6" />
      {hat === 'holly' ? <g data-part="holly">
        <path d="M13 5H16V6H15V7H14V6H13Z M17 5H20V6H19V7H18V6H17Z" fill="#2f9e5b" stroke="#14532d" strokeWidth="0.4" />
        <path d="M15.5 6H17.5V8H15.5Z" fill="#ff3b4e" stroke="#f6eee6" strokeWidth="0.4" />
      </g> : <path data-part="snowflake" d={SNOWFLAKE} stroke="#f6eee6" strokeWidth="0.7" />}
      <path d={BEANIE_BRIM} fill="#f6eee6" stroke="#5e1424" strokeWidth="1" />
      <path d={BEANIE_RIBS} stroke="#d9c6b6" strokeWidth="0.7" />
    </g>
  );
}
