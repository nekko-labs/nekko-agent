/**
 * Pictures a Photo chat edits (decision 0067: an attached image means edit).
 *
 * sd.cpp decodes reference images at their own size, so a 12-megapixel phone
 * photo would cost the model several times the memory of the picture it
 * makes. Photos are scaled down before they are attached, and the picture
 * that comes back keeps the photo's shape at the chat's usual pixel count.
 */

/** At most this many pictures to edit from (the engine refuses more). */
export const MAX_EDIT_PHOTOS = 4;
/** A photo's longest side once attached. */
export const MAX_PHOTO_EDGE = 1536;
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The files a Photo chat can edit, in order: PNG, JPEG and WebP only. */
export function photoFiles(files: File[]): File[] {
  return files.filter((f) => PHOTO_TYPES.has(f.type));
}

/** `width`x`height` scaled so the longest side is at most `max`, never enlarged. */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const snap = (n: number) => Math.min(2048, Math.max(256, Math.round(n / 64) * 64));

/**
 * The size to make an edit at: the photo's shape, with about as many pixels as
 * the chat's chosen size, in the multiples of 64 the engine accepts (256-2048).
 */
export function editSize(photo: { width: number; height: number }, chosen: { width: number; height: number }): { width: number; height: number } {
  if (!(photo.width > 0 && photo.height > 0)) return chosen;
  const area = chosen.width * chosen.height;
  const ratio = photo.width / photo.height;
  return { width: snap(Math.sqrt(area * ratio)), height: snap(Math.sqrt(area / ratio)) };
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That picture could not be read.'));
    img.src = src;
  });
}

/** A picture's own size, from its data URL. */
export async function photoSize(src: string): Promise<{ width: number; height: number }> {
  const img = await load(src);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

/** A file or data URL as a data URL no larger than `MAX_PHOTO_EDGE` on its longest side. */
export async function readPhoto(source: File | string): Promise<string> {
  const src = typeof source === 'string'
    ? source
    : await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(source);
      });
  const img = await load(src);
  const size = fitWithin(img.naturalWidth, img.naturalHeight);
  if (size.width === img.naturalWidth && size.height === img.naturalHeight) return src;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, size.width, size.height);
  // PNG keeps transparency; anything else goes back as a JPEG, much smaller.
  return src.startsWith('data:image/png') ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
}
