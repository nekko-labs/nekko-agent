/**
 * Regenerates the marketing site's icon from the same vector source as the app
 * icon, so the site can never drift back to a different mark.
 *
 *   node scripts/make-site-icon.cjs
 *
 * Writes apps/website/favicon.svg (the browser-tab icon: the app icon's tile,
 * drawn for small sizes) and apps/website/logo.svg (the nav/footer brand mark:
 * the gradient cat with no tile, so the page itself is its background).
 */
const { writeFileSync } = require('fs');
const { join } = require('path');
const { iconSvg, logoSvg } = require('../apps/desktop/scripts/icon-art.cjs');

const SITE = join(__dirname, '..', 'apps', 'website');

// Drawn for 32px, but with no width/height so CSS decides the rendered size:
// one file serves the 16px tab icon and the 22px nav mark.
writeFileSync(join(SITE, 'favicon.svg'), iconSvg(32).replace(/ width="\d+" height="\d+"/, ''));
writeFileSync(join(SITE, 'logo.svg'), logoSvg());
console.log('wrote apps/website/favicon.svg and apps/website/logo.svg');
