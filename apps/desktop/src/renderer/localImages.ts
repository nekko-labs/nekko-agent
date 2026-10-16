import type { FileContent } from '@nekko-agent/shared';

export const LOCAL_IMAGE_EXT = /\.(?:svg|png|jpe?g|gif|webp)$/i;

/** Only filesystem paths, never URL schemes, UNC shares or Windows device paths. */
export function localImagePath(src: string, basePath?: string): string | null {
  if (!LOCAL_IMAGE_EXT.test(src) || /[\x00-\x1f]/.test(src)) return null;
  if (/^(?:[\\/]{2}|\\)/.test(src)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
  const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(src);
  if (!absolute && !basePath) return null;
  const combined = (absolute ? src : `${basePath}/${src}`).replaceAll('\\', '/');
  if (/^\/\//.test(combined) || (!/^[a-z]:\//i.test(combined) && !combined.startsWith('/'))) return null;
  const parts: string[] = [];
  for (const part of combined.split('/')) {
    if (part === '..') { if (parts.length && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  const path = `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
  // Colons beyond the drive prefix can address alternate data streams on Windows.
  if (path.replace(/^[a-z]:/i, '').includes(':')) return null;
  return path;
}

/** SVG is an inert image document, never markup mounted into the app DOM. */
export function localImageData(path: string, file: FileContent): string | null {
  if (file.truncated) return null;
  if (/\.svg$/i.test(path)) {
    if (file.binary || !file.content.trim() || file.content.length > 1_000_000) return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`;
  }
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(file.imageDataUrl ?? '') ? file.imageDataUrl! : null;
}
