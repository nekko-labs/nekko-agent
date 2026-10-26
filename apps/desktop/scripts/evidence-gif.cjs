// Encode actual capturePage frames, using their own colors rather than a washed-out color cube.
const fs = require('node:fs');
const { PNG } = require('pngjs');
const { GifWriter } = require('omggif');
module.exports = function writeGif(file, buffers, delay = 8) {
  const frames = buffers.map(b => PNG.sync.read(b));
  const counts = new Map();
  for (const f of frames) for (let i = 0; i < f.data.length; i += 4) {
    const c = (f.data[i] << 16) | (f.data[i + 1] << 8) | f.data[i + 2];
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(x => x[0]);
  while (palette.length < 256) palette.push(0);
  const cache = new Map();
  const buffer = Buffer.alloc(frames[0].width * frames[0].height * frames.length * 2);
  const gif = new GifWriter(buffer, frames[0].width, frames[0].height, { palette, loop: 0 });
  for (const f of frames) {
    const pixels = new Uint8Array(f.width * f.height);
    for (let i = 0; i < pixels.length; i++) {
      const c = (f.data[i * 4] << 16) | (f.data[i * 4 + 1] << 8) | f.data[i * 4 + 2];
      if (!cache.has(c)) {
        let best = 0, distance = Infinity;
        for (let j = 0; j < palette.length; j++) {
          const p = palette[j];
          const d = ((c >> 16) - (p >> 16)) ** 2 + (((c >> 8) & 255) - ((p >> 8) & 255)) ** 2 + ((c & 255) - (p & 255)) ** 2;
          if (d < distance) { best = j; distance = d; }
        }
        cache.set(c, best);
      }
      pixels[i] = cache.get(c);
    }
    gif.addFrame(0, 0, f.width, f.height, pixels, { delay });
  }
  fs.writeFileSync(file, buffer.subarray(0, gif.end()));
};
