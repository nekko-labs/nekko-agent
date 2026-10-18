/**
 * The Nekko Agent mark, as vector art: an outline cat head (two ears, a soft
 * curve of forehead between them, a round jaw, nothing inside) in one thin
 * stroke with sharp corners, in white on the brand's indigo-to-lavender
 * gradient tile, plus the installer banners that
 * reuse it. Pure
 * string-building with no renderer behind it, so anything that needs the mark
 * -- the desktop icon pipeline, the phone app's icons, the marketing site's
 * favicon -- draws from this one source instead of keeping its own copy of the
 * shape. The renderer's `components/BrandMark.tsx` holds the same two paths
 * for the in-app mark; change one and change the other.
 */

/* ── the mark ─────────────────────────────────────────────────────────────── */

const VIEWBOX = 512;
const INK = '#ffffff';
/**
 * The brand gradient, left to right: deep indigo to lavender. The tile behind
 * the mark is painted in it. `TILE` is its deep end, for anything that needs a
 * single flat colour (the phone splash, Android's adaptive-icon background
 * colour); `RIM` is its light end, used for the installer banner's edge stripe.
 */
const TILE = '#453A92';
const TILE_END = '#9D8CE6';
const RIM = TILE_END;
/** A horizontal linear gradient across whatever it fills, as an SVG <defs> entry. */
const tileGradient = (id) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${TILE}"/><stop offset="1" stop-color="${TILE_END}"/></linearGradient>`;

/**
 * The head: two ears, a forehead that dips between them in a soft curve
 * rather than a flat bridge, a round jaw. Nothing inside the face. Drawn on a
 * 24-unit grid; the renderer's `BrandMark.tsx` carries the same path.
 *
 * The outline is a filled shape (outer edge, then the inner edge cut out by the
 * even-odd rule), one grid unit thick, exported from the design file rather than
 * stroked from a centre line, so the corners are exactly as drawn.
 */
const HEAD = 'M4.059,10.357C4.034,10.285 4.015,10.212 4.003,10.138L3.007,4.165L2.649,2.016L9.117,5.897C11.039,5.29 12.961,5.29 14.883,5.897L21.351,2.016L20.005,10.088C19.987,10.199 19.959,10.308 19.921,10.415L19.921,10.416C18.733,13.756 15.551,16.006 12,16.006C8.428,16.006 5.23,13.729 4.059,10.357L4.059,10.357ZM5.009,10.027C6.04,12.996 8.856,15 12,15C15.126,15 17.927,13.019 18.973,10.079C18.991,10.028 19.004,9.976 19.013,9.923L20,4L15,7C13,6.267 11,6.267 9,7L4,4L4.995,9.972C4.999,9.991 5.003,10.009 5.009,10.027Z';
/**
 * The visible bounds of that shape on the grid: ear tips to jaw, x 2.649..21.351,
 * y 2.016..16.006. Centring uses these, the ink you actually see. The old mark
 * centred a box that left out its stroke and stopped short of the ear tips, so
 * it sat about 5% high on the tile.
 */
const ART = { x: 2.649, y: 2.016, w: 18.702, h: 13.99 };
/** How much of a 512 tile the mark spans, ear tip to ear tip (the old mark's width). */
const SPAN = 378;

/**
 * The mark alone, drawn to fill `span` units of a square `box`, centred.
 * `size` is the final pixel size the art is chosen for: the line is thin at
 * icon size and heavier below 64 and 32 pixels, or it reads as a smudge in a
 * taskbar. Miter joins and flat caps keep the ear tips and notches sharp.
 */
function markGroup(size, box, span, color = INK) {
  const scale = span / Math.max(ART.w, ART.h);
  const tx = (box - ART.w * scale) / 2 - ART.x * scale;
  const ty = (box - ART.h * scale) / 2 - ART.y * scale;
  // The shape is one unit thick. Small sizes thicken it with a stroke the colour
  // of the fill, so the line is 2 units at 16-24 px and 1.5 below 64, as before.
  const extra = size < 32 ? 1.0 : size < 64 ? 0.5 : 0;
  const thicken = extra
    ? ` stroke="${color}" stroke-width="${extra}" stroke-linejoin="miter" stroke-miterlimit="8"`
    : '';
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" fill="${color}" fill-rule="evenodd"${thicken}>
      <path d="${HEAD}"/>
    </g>`;
}

/**
 * The app icon: the white mark on a squircle tile painted in the brand
 * gradient. The tile is bright enough to hold its own edge on a dark taskbar,
 * so it needs no rim light. Everything is expressed in a 512 viewBox and
 * scaled by the renderer, so the only size-dependent decisions are how much
 * detail survives.
 */
function iconSvg(size, px = size) {
  const corner = 114; // 22.3% of 512, the platform squircle radius
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  <defs>
    <clipPath id="squircle">
      <rect x="0" y="0" width="512" height="512" rx="${corner}" ry="${corner}"/>
    </clipPath>
    ${tileGradient('tile')}
  </defs>

  <g clip-path="url(#squircle)">
    <rect width="512" height="512" fill="url(#tile)"/>
    ${markGroup(size, VIEWBOX, SPAN)}
  </g>
</svg>`;
}

/**
 * The mark with nothing behind it, for places that paint their own ground:
 * Android's adaptive-icon layers (which keep the middle 66% safe), the phone
 * splash, and the monochrome variant. `inset` is the share of the box the art
 * may fill.
 */
/**
 * `inset` used to size the old mark's centre line, and its visible ink came out
 * 7.5% wider (17.2 vs 16 grid units). The phone layers keep that size.
 */
const BARE_SIZE = 17.2 / 16;

/** `background: 'gradient'` paints the brand gradient; any other value but 'none' is a flat fill. */
function bareMarkSvg(px, { color = INK, inset = 0.72, background = 'none' } = {}) {
  const ground =
    background === 'none'
      ? ''
      : background === 'gradient'
        ? `<defs>${tileGradient('ground')}</defs><rect width="512" height="512" fill="url(#ground)"/>`
        : `<rect width="512" height="512" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  ${ground}
  ${markGroup(px, VIEWBOX, Math.round(VIEWBOX * inset * BARE_SIZE), color)}
</svg>`;
}

/**
 * The mark with no tile, painted in the brand gradient, for the marketing
 * site's header and footer: the page's own colour is the ground there, so the
 * tile belongs only to the app icon and the favicon. The viewBox hugs the ink
 * (with a little room for the thickening stroke) so the mark lines up with the
 * wordmark beside it instead of floating in a square.
 */
function logoSvg() {
  const pad = 0.6;
  const vb = [ART.x - pad, ART.y - pad, ART.w + pad * 2, ART.h + pad * 2].map((n) => +n.toFixed(3));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}">
  <defs><linearGradient id="mark" gradientUnits="userSpaceOnUse" x1="${ART.x}" y1="0" x2="${(ART.x + ART.w).toFixed(3)}" y2="0"><stop offset="0" stop-color="${TILE}"/><stop offset="1" stop-color="${TILE_END}"/></linearGradient></defs>
  <path d="${HEAD}" fill="url(#mark)" fill-rule="evenodd" stroke="url(#mark)" stroke-width="0.5" stroke-linejoin="miter" stroke-miterlimit="8"/>
</svg>
`;
}

/* ── the NSIS installer art ───────────────────────────────────────────────── */

/**
 * The Windows installer's header strip and sidebar panel. Same gradient, same
 * mark, and the product's actual name in white.
 */
function bannerSvg(w, h, opts, pw = w, ph = h) {
  const { markSize, markX, markY, title, titleSize, layout } = opts;
  const inner = iconSvg(512)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  const column = layout === 'column';
  const tagline = column ? 'AI on your computer' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">
  <defs>${tileGradient('panel')}</defs>
  <rect width="${w}" height="${h}" fill="url(#panel)"/>
  <rect width="${column ? 3 : 2}" height="${h}" fill="${RIM}"/>
  <g transform="translate(${markX} ${markY}) scale(${markSize / 512})">${inner}</g>
  <text x="${column ? w / 2 : markX + markSize + 14}" y="${column ? markY + markSize + 46 : h / 2 + titleSize * 0.36}"
        text-anchor="${column ? 'middle' : 'start'}" fill="${INK}"
        font-family="Segoe UI, system-ui, sans-serif" font-size="${titleSize}" font-weight="600"
        letter-spacing="${(titleSize * 0.06).toFixed(2)}">${title}</text>
  ${tagline
      ? `<text x="${w / 2}" y="${markY + markSize + 76}" text-anchor="middle" fill="${INK}"
        font-family="Segoe UI, system-ui, sans-serif" font-size="13">${tagline}</text>`
      : ''}
</svg>`;
}

module.exports = { iconSvg, bareMarkSvg, logoSvg, bannerSvg, TILE, TILE_END, INK, HEAD, ART };
