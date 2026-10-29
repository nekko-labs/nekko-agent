import React from 'react';

/**
 * The Nekko Agent mark: an outline cat head, two ears with a soft curve of
 * forehead between them and a round jaw, nothing inside. The outline is a
 * filled shape one grid unit thick, exported from the design file, so its
 * corners are exactly as drawn. The same path draws the app icon, the installer
 * art, the web manifest icon, the phone app's icons and the marketing site's
 * favicon (`apps/desktop/scripts/icon-art.cjs` holds the copy those pipelines
 * read, since they run outside the bundle); change one and change the other.
 */
export const BRAND_HEAD =
  'M4.059,10.357C4.034,10.285 4.015,10.212 4.003,10.138L3.007,4.165L2.649,2.016L9.117,5.897C11.039,5.29 12.961,5.29 14.883,5.897L21.351,2.016L20.005,10.088C19.987,10.199 19.959,10.308 19.921,10.415L19.921,10.416C18.733,13.756 15.551,16.006 12,16.006C8.428,16.006 5.23,13.729 4.059,10.357L4.059,10.357ZM5.009,10.027C6.04,12.996 8.856,15 12,15C15.126,15 17.927,13.019 18.973,10.079C18.991,10.028 19.004,9.976 19.013,9.923L20,4L15,7C13,6.267 11,6.267 9,7L4,4L4.995,9.972C4.999,9.991 5.003,10.009 5.009,10.027Z';

/**
 * The 24-unit view the mark was drawn on, shifted so it is centred on the ink
 * of the shape (x 2.649..21.351, y 2.016..16.006, centre 12, 9.011) rather than
 * on the grid. The drawing sits 3 units above the grid centre, which put the
 * cat high in its box; the same size, re-centred, puts it in the middle.
 */
export const BRAND_VIEWBOX = '0 -2.989 24 24';

export function BrandMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  // The shape is one unit thick; a matching stroke brings the line to 1.5
  // units, and 2 below 32 px (the title bar) so it survives a 16 px render.
  const strokeWidth = size < 32 ? 1 : 0.5;
  return (
    <svg
      viewBox={BRAND_VIEWBOX}
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="miter"
      strokeMiterlimit={8}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={BRAND_HEAD} />
    </svg>
  );
}
