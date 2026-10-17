import { createHash } from 'node:crypto';
import { PHONE_SESSION_VIEW } from '@nekko-agent/shared';

/** Thumbnails already made, by the photo's hash: a phone re-reads a chat often. */
const CACHE_MAX = 200;
const cache = new Map<string, string>();

const QUALITY = 70;

/**
 * A photo from a chat as a phone sees it (`PHONE_SESSION_VIEW`): a JPEG data
 * URL, the long side at most `thumbSide` px (never enlarged). `''` when the
 * data URL is not an image Jimp can read or the result is still too large.
 * Only for the copy sent to a phone; the chat keeps the original.
 */
export async function phoneThumbnail(dataUrl: string): Promise<string> {
  const key = createHash('sha256').update(dataUrl).digest('base64');
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const out = await make(dataUrl);
  cache.set(key, out);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return out;
}

async function make(dataUrl: string): Promise<string> {
  const m = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/s.exec(dataUrl);
  if (!m) return '';
  try {
    const { Jimp } = await import('jimp');
    const image = await Jimp.read(Buffer.from(m[2], 'base64'));
    const side = PHONE_SESSION_VIEW.thumbSide;
    const edge = Math.max(image.width, image.height);
    if (edge > side) {
      image.resize({
        w: Math.max(1, Math.round((image.width * side) / edge)),
        h: Math.max(1, Math.round((image.height * side) / edge)),
      });
    }
    const jpeg = await image.getBuffer('image/jpeg', { quality: QUALITY });
    const url = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    return url.length <= PHONE_SESSION_VIEW.thumbChars ? url : '';
  } catch {
    return '';
  }
}
