// Palette drawn from the captured pixels, not a synthetic color cube.
const { PNG } = require('pngjs');
const { GifWriter } = require('omggif');
module.exports = function encode(frames) {
  const decoded = frames.map((frame) => PNG.sync.read(frame));
  const counts = new Map();
  for (const { data } of decoded) for (let i = 0; i < data.length; i += 4) {
    const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([color]) => color);
  while (palette.length < 256) palette.push(palette[0]);
  const cache = new Map(palette.map((color, index) => [color, index]));
  const buffer = Buffer.alloc(decoded[0].width * decoded[0].height * decoded.length + 1024 * 1024);
  const writer = new GifWriter(buffer, decoded[0].width, decoded[0].height, { loop: 0, palette });
  decoded.forEach(({ width, height, data }, frame) => {
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 4) {
      const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      let index = cache.get(color);
      if (index === undefined) {
        let distance = Infinity;
        palette.forEach((p, n) => {
          const d = ((p >> 16) - data[i]) ** 2 + (((p >> 8) & 255) - data[i + 1]) ** 2 + ((p & 255) - data[i + 2]) ** 2;
          if (d < distance) { distance = d; index = n; }
        });
        cache.set(color, index);
      }
      indices[i / 4] = index;
    }
    writer.addFrame(0, 0, width, height, indices, { delay: frame === 0 || frame === decoded.length - 1 ? 60 : 10 });
  });
  return buffer.subarray(0, writer.end());
};
