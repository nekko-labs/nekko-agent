import { useEffect, useMemo, useState } from 'react';
import { highlightHtml, loadHighlighter } from '../codeHighlight.js';

/** Only mounted for visible details. Keep partial fences and long output cheap. */
export function HighlightedCode({ text, language }: { text: string; language: string }) {
  const [api, setApi] = useState<Awaited<ReturnType<typeof loadHighlighter>> | null>(null);
  const word = language.trim().toLowerCase().split(/\s+/, 1)[0];
  const lang = word === 'shell' || word === 'zsh' ? 'bash' : word;
  const paint = !!lang && text.length > 0 && text.length <= 32_000;
  useEffect(() => {
    let current = true;
    if (paint) void loadHighlighter().then(hl => { if (current) setApi(hl); }, () => {});
    return () => { current = false; };
  }, [paint]);
  const html = useMemo(() => paint && api?.getLanguage(lang) ? highlightHtml(api, text, lang) : null, [paint, api, text, lang]);
  // Only highlight.js's source-escaped output is HTML. Fallbacks are React text.
  return html === null ? <code>{text}</code> : <code className="code-paint" dangerouslySetInnerHTML={{ __html: html }} />;
}
