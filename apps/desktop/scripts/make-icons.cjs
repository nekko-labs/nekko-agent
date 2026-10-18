/**
 * Regenerates the app icons from the vector source in ./icon-art.cjs.
 *
 *   npx electron apps/desktop/scripts/make-icons.cjs
 *
 * Electron is the rasterizer (it is already a devDependency, and it is the same
 * renderer that will draw the app), so there is no new native/image toolchain to
 * install. Each size is drawn at its own size rather than downscaled from one
 * big render: below 48px the art drops the stars and thickens the strokes, which
 * is the difference between a readable taskbar icon and a smudge.
 *
 * Writes build/icon.svg (512 reference), build/icon.png (512, what
 * electron-builder uses for mac/linux), renderer/icon.svg (small vector mark),
 * and build/icon.ico (Windows, PNG-encoded entries at every size Explorer asks
 * for).
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync } = require('fs');
const { join } = require('path');
const { iconSvg, bareMarkSvg, bannerSvg } = require('./icon-art.cjs');

const BUILD = join(__dirname, '..', 'build');
const PUBLIC = join(__dirname, '..', 'src', 'renderer', 'public');
const MOBILE = join(__dirname, '..', '..', 'mobile', 'assets', 'images');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Draw `svg` at `w`x`h` CSS pixels and return exactly that many device pixels.
 *
 * Two traps here. capturePage honours the display's scale factor, so on a 125%
 * monitor a 512px window yields a 640px bitmap, and an .ico whose directory
 * claims 16px while holding a 20px image is malformed. And Windows refuses to
 * make a window as small as a 16px icon. Both are solved by drawing large and
 * resizing down, which also supersamples the curve for free.
 */
async function shoot(win, svgFor, w, h) {
  const scale = Math.max(1, Math.ceil(256 / Math.max(w, h)), 2);
  const rw = Math.round(w * scale);
  const rh = Math.round(h * scale);
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block}</style>${svgFor(rw, rh)}`;
  win.setBounds({ x: 0, y: 0, width: rw, height: rh });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // One frame after load, so gradients are painted before the capture.
  await new Promise((r) => setTimeout(r, 120));
  const shot = await win.capturePage({ x: 0, y: 0, width: rw, height: rh });
  return shot.getSize().width === w && shot.getSize().height === h
    ? shot
    : shot.resize({ width: w, height: h, quality: 'best' });
}

async function render(win, size) {
  // The art is chosen for the final size; only the raster is supersampled.
  return (await shoot(win, (rw) => iconSvg(size, rw), size, size)).toPNG();
}

/** Encode a nativeImage as an uncompressed 24-bit BMP, which is all NSIS reads. */
function toBmp24(image) {
  const { width, height } = image.getSize();
  const rgba = image.toBitmap(); // BGRA, top-down
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    // BMP rows run bottom-up.
    const src = (height - 1 - y) * width * 4;
    let at = y * rowSize;
    for (let x = 0; x < width; x++) {
      pixels[at++] = rgba[src + x * 4 + 0]; // B
      pixels[at++] = rgba[src + x * 4 + 1]; // G
      pixels[at++] = rgba[src + x * 4 + 2]; // R
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14); // DIB header size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bpp
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38); // 72 DPI
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

/** Pack PNG buffers into an .ico (PNG-compressed entries, Vista+). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at + 0); // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2); // palette
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });

  writeFileSync(join(BUILD, 'icon.svg'), iconSvg(512));

  win.setBounds({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(join(BUILD, 'icon.png'), await render(win, 512));

  const entries = [];
  for (const size of SIZES) {
    win.setBounds({ x: 0, y: 0, width: size, height: size });
    entries.push({ size, png: await render(win, size) });
  }
  writeFileSync(join(BUILD, 'icon.ico'), buildIco(entries));

  // The web/PWA edition's icon (also the apple-touch-icon) is the same art.
  writeFileSync(join(PUBLIC, 'icon-512.png'), await render(win, 512));
  writeFileSync(join(PUBLIC, 'icon.svg'), iconSvg(512, 64));

  // NSIS art. Sizes are fixed by the installer: 150x57 header, 164x314 sidebar.
  const header = await shoot(
    win,
    (pw, ph) => bannerSvg(150, 57, { markSize: 40, markX: 10, markY: 8, title: 'Nekko Agent', titleSize: 12, layout: 'row' }, pw, ph),
    150,
    57,
  );
  writeFileSync(join(BUILD, 'installerHeader.bmp'), toBmp24(header));
  const sidebar = await shoot(
    win,
    (pw, ph) =>
      bannerSvg(
        164,
        314,
        { markSize: 88, markX: 38, markY: 62, title: 'Nekko Agent', tagline: 'Local-first AI coding', titleSize: 22, layout: 'column' },
        pw,
        ph,
      ),
    164,
    314,
  );
  writeFileSync(join(BUILD, 'installerSidebar.bmp'), toBmp24(sidebar));

  // The phone app (Expo) takes PNGs: the tile for the iOS/app icon and the web
  // favicon, and bare layers for Android's adaptive icon and the splash.
  writeFileSync(join(MOBILE, 'icon.png'), await render(win, 1024));
  writeFileSync(join(MOBILE, 'favicon.png'), await render(win, 48));
  const bare = (px, opts) => shoot(win, (rw) => bareMarkSvg(rw, opts), px, px);
  writeFileSync(join(MOBILE, 'splash-icon.png'), (await bare(512, { inset: 0.8 })).toPNG());
  writeFileSync(join(MOBILE, 'android-icon-foreground.png'), (await bare(512, { inset: 0.5 })).toPNG());
  writeFileSync(join(MOBILE, 'android-icon-monochrome.png'), (await bare(512, { inset: 0.5, color: '#ffffff' })).toPNG());
  writeFileSync(join(MOBILE, 'android-icon-background.png'), (await bare(512, { inset: 0, background: 'gradient' })).toPNG());

  console.log(
    `wrote icon.svg, icon.png (512), icon.ico (${SIZES.join(', ')}), renderer icon.svg + icon-512.png, the two installer BMPs, and the phone app's icons`,
  );
  win.destroy();
  app.quit();
});
