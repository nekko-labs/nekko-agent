import React from 'react';

/**
 * One line of text that, when it does not fit, loses its middle rather than
 * its end, so what tells similar items apart stays visible: a model's shard
 * and quant (`...Q4_K_M-00001-of-00002.gguf`), a file's extension, the last
 * folders of a path. The full text is the tooltip. Must sit in a box that can
 * shrink (min-w-0).
 */
export function MiddleTruncate({ text, tail = 16, className = '' }: { text: string; tail?: number; className?: string }) {
  if (text.length <= tail + 4) return <span className={`min-w-0 truncate ${className}`} title={text} dir="auto">{text}</span>;
  return (
    <span className={`flex min-w-0 ${className}`} title={text} dir="auto">
      <span className="min-w-0 truncate">{text.slice(0, -tail)}</span>
      <span className="shrink-0 whitespace-pre">{text.slice(-tail)}</span>
    </span>
  );
}
