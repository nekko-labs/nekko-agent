import { LOCAL_IMAGE_EXT, localImagePath } from './localImages.js';

export interface ChatArtifact { path: string; title: string; filename: string; inlineImage?: boolean }

/** Explicit local document/image links, never code examples or network resources. */
export function chatArtifacts(text: string, basePath?: string): ChatArtifact[] {
  const out = new Map<string, ChatArtifact>();
  const source = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of source.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
    const label = match[2].trim();
    const href = match[3].trim().replace(/^<|>$/g, '');
    const image = LOCAL_IMAGE_EXT.test(href);
    if (image && !localImagePath(href, basePath)) continue;
    if (match[1] && !image) continue;
    if (/^(?:https?:|mailto:|data:|javascript:|file:|#|\\\\|\/\/)/i.test(href)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) continue;
    if (!/\.(?:md|markdown|html?|svg|png|jpe?g|gif|webp|pdf|csv|json|txt|docx?|xlsx?|pptx?)$/i.test(href)) continue;
    const absolute = /^(?:[a-z]:[\\/]|\/)/i.test(href);
    if (!absolute && !basePath) continue;
    const combined = absolute ? href : `${basePath}/${href}`;
    const parts: string[] = [];
    for (const part of combined.replaceAll('\\', '/').split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    const path = `${combined.startsWith('/') ? '/' : ''}${parts.join('/')}`;
    const filename = parts.at(-1) || href;
    const generic = /^(?:readme|index)(?:\.[a-z]+)?$/i.test(label) || label === filename;
    const fallback = /^(?:readme|index)\./i.test(filename) ? parts.at(-2) || 'Document' : filename.replace(/\.[^.]+$/, '');
    const title = generic ? fallback.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()) : label;
    const key = path.toLowerCase();
    const previous = out.get(key);
    if (!previous) out.set(key, { path, title: title || filename, filename, ...(match[1] ? { inlineImage: true } : {}) });
    else if (match[1]) previous.inlineImage = true;
  }
  return [...out.values()];
}
