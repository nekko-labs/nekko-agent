// Renders docs/brand/nekko-banner.html to docs/brand/nekko-banner-1280x640.png.
// Afterwards run `node scripts/make-site-icon.cjs` to refresh apps/website/og.png.
const { chromium } = require('playwright');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(__dirname, '../docs/brand/nekko-banner.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(__dirname, '../docs/brand/nekko-banner-1280x640.png'), omitBackground: false });
  await browser.close();
  console.log('wrote docs/brand/nekko-banner-1280x640.png');
})();
