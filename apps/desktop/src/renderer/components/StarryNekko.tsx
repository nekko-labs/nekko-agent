import React from 'react';
import { PixelHead } from './Mascot.js';

/** Nekko delighted: star eyes and a wide smile. Still, so it can sit beside text as an icon. */
export function StarryNekko({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} shapeRendering="crispEdges" aria-hidden focusable="false" className="shrink-0">
      <PixelHead eyes={false} mouth={false} />
      <path fill="#fbbf24" d="M11 13H12V15H13V16H14V17H13V18H12V20H11V18H10V17H9V16H10V15H11Z M20 13H21V15H22V16H23V17H22V18H21V20H20V18H19V17H18V16H19V15H20Z" />
      <path fill="#a7c8ac" d="M13 20H14V21H18V20H19V22H18V23H14V22H13Z" />
    </svg>
  );
}
