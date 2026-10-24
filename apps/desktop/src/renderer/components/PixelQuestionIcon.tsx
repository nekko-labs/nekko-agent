import React from 'react';

/** A hand-drawn 8-bit question mark, with whole-pixel corners at small sizes. */
export function PixelQuestionIcon({ className }: { className?: string }) {
  return <svg className={className} data-pixel-question viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
    <path d="M4 1h7v2h2v5h-2v2H9v2H6V9h2V7h2V4H5v2H2V3h2zM6 14h3v2H6z" />
  </svg>;
}
