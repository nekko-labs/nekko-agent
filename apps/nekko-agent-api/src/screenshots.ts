import { Readable } from "node:stream";
import { createInflate, crc32 } from "node:zlib";

/**
 * Send feedback's optional screenshots (spec/platform/send-feedback.md). The
 * apps check the first bytes too, but that runs on the sender's machine, so
 * everything is checked again here: the file must be a whole, well-formed PNG
 * or JPEG, and what is stored is a copy with its metadata taken out (a phone
 * photo's location, a camera's serial, text an editor wrote in).
 */

export const MAX_SCREENSHOTS = 3;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** The longest base64 a 5 MB file can be. */
export const MAX_SCREENSHOT_BASE64 = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;
/** Pixels a screenshot may have, so a small file can't claim a huge image (8K is 33 megapixels). */
const MAX_PIXELS = 40_000_000;

export type ScreenshotType = "image/png" | "image/jpeg";
export interface Screenshot {
  type: ScreenshotType;
  data: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * `screenshots` from a request body: 1 to 3 of `{ type, data }`, `data` in
 * base64. Anything else in an entry (the file's name included) is dropped.
 * Returns false for a malformed list; the bytes are checked by `cleanScreenshot`.
 */
export function parseScreenshotList(v: unknown): { type: ScreenshotType; data: Buffer }[] | false {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SCREENSHOTS) return false;
  const out: { type: ScreenshotType; data: Buffer }[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const { type, data } = item as Record<string, unknown>;
    if (type !== "image/png" && type !== "image/jpeg") return false;
    if (typeof data !== "string" || !data || data.length > MAX_SCREENSHOT_BASE64 || data.length % 4 || !BASE64.test(data)) return false;
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_SCREENSHOT_BYTES) return false;
    out.push({ type, data: bytes });
  }
  return out;
}

/** The screenshot as it will be stored, or null when its bytes aren't the image its type says. */
export async function cleanScreenshot(type: ScreenshotType, data: Buffer): Promise<Buffer | null> {
  return type === "image/png" ? cleanPng(data) : cleanJpeg(data);
}

// PNG: every chunk whole with a matching CRC, IHDR first, IEND last with
// nothing after it, and the image data inflating to exactly the size IHDR
// promises. Only the chunks that draw the picture are kept: text, eXIf, tIME
// and private chunks are dropped.
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "cICP"]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

async function cleanPng(png: Buffer): Promise<Buffer | null> {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const kept: Buffer[] = [PNG_SIGNATURE];
  const idat: Buffer[] = [];
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null;
  let at = 8;
  let ended = false;
  while (at < png.length) {
    if (ended || at + 12 > png.length) return null;
    const length = png.readUInt32BE(at);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > png.length) return null;
    const type = png.toString("latin1", at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    if (crc32(png.subarray(at + 4, at + 8 + length)) !== png.readUInt32BE(at + 8 + length)) return null;
    const body = png.subarray(at + 8, at + 8 + length);
    if (!header) {
      if (type !== "IHDR" || length !== 13) return null;
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8]!, color: body[9]!, interlace: body[12]! };
      const { width, height, depth, color, interlace } = header;
      if (!width || !height || width * height > MAX_PIXELS || !DEPTHS[color]?.includes(depth) || body[10] !== 0 || body[11] !== 0 || interlace > 1) return null;
    } else if (type === "IHDR") return null;
    if (type === "IDAT") idat.push(body);
    if (type === "IEND") ended = true;
    if (PNG_KEEP.has(type)) kept.push(png.subarray(at, end));
    at = end;
  }
  if (!header || !ended || !idat.length) return null;
  if (header.color === 3 && !kept.some((c) => c.toString("latin1", 4, 8) === "PLTE")) return null;
  return (await inflatedLength(idat, expectedPngBytes(header) + 1)) === expectedPngBytes(header) ? Buffer.concat(kept) : null;
}

/** Bytes the image data inflates to: per row, a filter byte and the row's pixels. */
function expectedPngBytes(h: { width: number; height: number; depth: number; color: number; interlace: number }): number {
  const bits = h.depth * CHANNELS[h.color]!;
  const rows = (w: number, rowCount: number) => (w && rowCount ? rowCount * (1 + Math.ceil((w * bits) / 8)) : 0);
  if (!h.interlace) return rows(h.width, h.height);
  return ADAM7.reduce((sum, [x, y, dx, dy]) => sum + rows(Math.ceil(Math.max(0, h.width - x!) / dx!), Math.ceil(Math.max(0, h.height - y!) / dy!)), 0);
}

/** Inflates the zlib stream, counting bytes without keeping them; -1 when it's broken. Stops past `limit`. */
function inflatedLength(chunks: Buffer[], limit: number): Promise<number> {
  return new Promise((resolve) => {
    let total = 0;
    const inflate = createInflate();
    inflate.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        inflate.destroy();
        resolve(total);
      }
    });
    inflate.on("end", () => resolve(total));
    inflate.on("error", () => resolve(-1));
    Readable.from(chunks).pipe(inflate);
  });
}

// JPEG: SOI, marker segments that fit, a frame header with a size, at least
// one scan with data, and EOI; anything after EOI (a phone's extra images) is
// cut. EXIF, XMP, IPTC, comments and other APPn segments are dropped; JFIF,
// the ICC colour profile and Adobe's colour transform are kept.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_KEEP_APP: Record<number, string> = { 0xe0: "JFIF\0", 0xe2: "ICC_PROFILE\0", 0xee: "Adobe" };

function cleanJpeg(jpg: Buffer): Buffer | null {
  if (jpg.length < 4 || jpg[0] !== 0xff || jpg[1] !== 0xd8) return null;
  const kept: Buffer[] = [jpg.subarray(0, 2)];
  let at = 2;
  let frame = false;
  let scans = 0;
  for (;;) {
    if (jpg[at] !== 0xff) return null;
    while (jpg[at] === 0xff) at++;
    const marker = jpg[at++];
    if (marker === undefined || marker === 0x00) return null;
    if (marker === 0xd9) {
      if (!frame || !scans) return null;
      kept.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(kept);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null;
    if (at + 2 > jpg.length) return null;
    const length = jpg.readUInt16BE(at);
    const end = at + length;
    if (length < 2 || end > jpg.length) return null;
    const body = jpg.subarray(at + 2, end);
    const segment = jpg.subarray(at - 2, end);
    if (SOF.has(marker)) {
      if (frame || body.length < 6 || !body.readUInt16BE(1) || !body.readUInt16BE(3)) return null;
      if (body.readUInt16BE(1) * body.readUInt16BE(3) > MAX_PIXELS) return null;
      frame = true;
    }
    const app = JPEG_KEEP_APP[marker];
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!(isApp && !(app && body.toString("latin1", 0, app.length) === app)) && marker !== 0xfe) kept.push(segment);
    at = end;
    if (marker === 0xda) {
      if (!frame) return null;
      // Entropy-coded data runs to the next marker that isn't a stuffed 0xFF00 or a restart.
      const start = at;
      while (at + 1 < jpg.length && !(jpg[at] === 0xff && jpg[at + 1] !== 0x00 && !(jpg[at + 1]! >= 0xd0 && jpg[at + 1]! <= 0xd7))) at++;
      if (at + 1 >= jpg.length || at === start) return null;
      kept.push(jpg.subarray(start, at));
      scans++;
    }
  }
}
