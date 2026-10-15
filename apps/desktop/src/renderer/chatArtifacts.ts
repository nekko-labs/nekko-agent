export interface ChatArtifact { path: string; title: string; filename: string }

/** Only explicit local document links, never code examples or network resources. */
export function chatArtifacts(text: string, basePath?: string): ChatArtifact[] {
  const out = new Map<string, ChatArtifact>();
  const source = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of source.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
    const label = match[1].trim();
    const href = match[2].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|data:|javascript:|file:|#|\\\\|\/\/)/i.test(href)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) continue;
    if (!/\.(?:md|markdown|html?|svg|pdf|csv|json|txt|docx?|xlsx?|pptx?)$/i.test(href)) continue;
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
    if (!out.has(path.toLowerCase())) out.set(path.toLowerCase(), { path, title, filename });
  }
  return [...out.values()];
}
