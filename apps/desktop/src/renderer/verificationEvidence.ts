import { localImagePath } from './localImages.js';
import { remoteImageUrl } from './remoteImages.js';

export interface EvidenceImage { src: string; label: string }
export interface EvidencePair { surface: string; before: EvidenceImage; after: EvidenceImage }

/** Explicit labels only, from this reply's prose, never filenames or code samples. */
export function verificationPairs(text: string, basePath?: string): EvidencePair[] {
  const surfaces = new Map<string, { surface: string; before?: EvidenceImage; after?: EvidenceImage }>();
  const prose = text.split(/```[^\n]*\n[\s\S]*?(?:```|$)/).join('\n').replace(/`[^`\n]*`/g, '');
  for (const match of prose.matchAll(/!\[([^\]]*)\]\(([^\s)]+)\)/g)) {
    const label = /^(before|after)(?:\s*[:\-]\s*|\s+|$)(.*)$/i.exec(match[1].trim());
    if (!label || (!localImagePath(match[2], basePath) && !remoteImageUrl(match[2]))) continue;
    const surface = label[2].trim() || 'Visual change';
    const key = surface.toLowerCase();
    const pair = surfaces.get(key) ?? { surface };
    const side = label[1].toLowerCase() as 'before' | 'after';
    pair[side] ??= { src: match[2], label: match[1] };
    surfaces.set(key, pair);
  }
  return [...surfaces.values()].filter((p): p is EvidencePair => !!p.before && !!p.after && p.before.src !== p.after.src);
}
