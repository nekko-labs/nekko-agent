// Generates branded NSIS installer images (sidebar + header) from the app icon.
// Run: node apps/desktop/scripts/gen-installer-art.mjs
import { Jimp, loadFont, rgbaToInt, HorizontalAlign } from 'jimp';
import { SANS_16_WHITE } from 'jimp/fonts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const build = resolve(__dirname, '../build');
const BG = rgbaToInt(16, 23, 20, 255); // Nekko Agent dark green #101714
const ACCENT = rgbaToInt(167, 200, 172, 255); // sage #a7c8ac

const tintFont = (font) => {
  for (const page of font.pages) {
    for (let i = 0; i < page.bitmap.data.length; i += 4) {
      page.bitmap.data[i] = 167;
      page.bitmap.data[i + 1] = 200;
      page.bitmap.data[i + 2] = 172;
    }
  }
  return font;
};
const icon = await Jimp.read(resolve(build, 'icon.png'));
const f16 = tintFont(await loadFont(SANS_16_WHITE));
const f14 = tintFont(await loadFont(SANS_16_WHITE));

// --- Welcome/finish sidebar: 164 x 314 ---
const side = new Jimp({ width: 164, height: 314, color: BG });
// subtle accent bar down the left edge
for (let y = 0; y < 314; y++) for (let x = 0; x < 3; x++) side.setPixelColor(ACCENT, x, y);
const paw = icon.clone().resize({ w: 88, h: 88 });
side.composite(paw, (164 - 88) / 2, 62);
side.print({ font: f16, x: 0, y: 188, text: { text: 'Nekko Agent', alignmentX: HorizontalAlign.CENTER }, maxWidth: 164 });
side.print({
  font: f16,
  x: 8,
  y: 226,
  text: { text: 'AI on your computer', alignmentX: HorizontalAlign.CENTER },
  maxWidth: 148,
});
await side.write(resolve(build, 'installerSidebar.bmp'));

// --- Inner-page header: 150 x 57 ---
const header = new Jimp({ width: 150, height: 57, color: BG });
const smallPaw = icon.clone().resize({ w: 40, h: 40 });
header.composite(smallPaw, 10, 8);
header.print({ font: f14, x: 64, y: 18, text: 'Nekko Agent' });
await header.write(resolve(build, 'installerHeader.bmp'));

console.log('wrote installerSidebar.bmp (164x314) + installerHeader.bmp (150x57)');
