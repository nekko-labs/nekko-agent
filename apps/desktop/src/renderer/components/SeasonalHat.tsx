import React from 'react';
import type { SeasonalHat } from '../seasonal.js';

/**
 * The wizard hat is drawn at full size on the head's grid, then shrunk to 80% around
 * its brim and lifted so the brim sits on the crown between the ears rather
 * than over the forehead.
 */
const WIZARD_HAT_TRANSFORM = 'translate(16.5 9) scale(0.8) translate(-16.5 -12)';

/**
 * A seasonal theme's hat, on the head's 32-unit grid. The wizard hat is
 * Spooky's. Winter's knit beanie sits on the crown between the ears, so the
 * ears poke out either side of it; on December 24 and 25 it becomes a Santa
 * hat whose tip flops over the right ear (seasonal.ts).
 */
export function SeasonalHatArt({ hat }: { hat: SeasonalHat }) {
  if (hat === 'wizard') return (
    <g data-part="orange-wizard-hat" strokeLinejoin="miter" transform={WIZARD_HAT_TRANSFORM}>
      <polygon points="9,10 16,0 19,2 23,10" fill="#fb923c" stroke="#9a3412" strokeWidth="1" />
      <rect x="8" y="9" width="17" height="3" fill="#ea580c" stroke="#9a3412" strokeWidth="1" />
      <rect x="16" y="7" width="3" height="2" fill="#fde68a" />
    </g>
  );
  if (hat === 'santa') return (
    <g data-part="santa-hat" strokeLinejoin="miter">
      <path d="M9 10V6H11V4H14V3H20V4H23V5H26V8H24V10Z" fill="#d6283b" stroke="#7f1020" strokeWidth="1" />
      <rect x="8" y="9" width="17" height="3" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
      <rect x="25" y="7" width="3" height="3" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
    </g>
  );
  return (
    <g data-part="winter-beanie" strokeLinejoin="miter">
      <path d="M9 10V6H11V4H21V6H23V10Z" fill="#3b7fc4" stroke="#163a63" strokeWidth="1" />
      {/* Knit ribs. */}
      <path d="M13 5V9M16 4V9M19 5V9" stroke="#7fb6e6" strokeWidth="1" />
      <rect x="8" y="9" width="17" height="3" fill="#e8f1fb" stroke="#163a63" strokeWidth="1" />
      <rect x="14" y="1" width="4" height="3" fill="#ffffff" stroke="#94a3b8" strokeWidth="1" />
    </g>
  );
}
