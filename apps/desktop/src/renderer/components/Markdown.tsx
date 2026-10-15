import React, { useState } from 'react';
import { MermaidDiagram } from './ArtifactPreview.js';

import { ContextAction, ContextMenu } from './ContextMenu.js';
import { useStore } from '../store.js';


/**
 * Minimal, dependency-free markdown renderer covering the constructs a chat
 * actually contains: fenced code blocks, headings, bullet and numbered lists
 * (nested), pipe tables, block quotes, rules, and inline bold / italic /
 * strikethrough / code / links / images. Kept intentionally small; not a full
 * CommonMark implementation.
 *
 * Blocks are found by scanning lines rather than by splitting on blank lines, so
 * a run of dashes glued to the sentence above it still becomes a real list, the
 * way it does in every other chat surface. Single newlines inside a paragraph
 * are kept as line breaks, since people write chat messages that way.
 *
 * Two flavors, because a chat bubble and a README want opposite things:
 *  - default (chat): tight spacing, headings barely louder than body text,
 *    hard-wrapped lines preserved as written.
 *  - `doc` (the file viewer): a real typographic scale (h1-h6), generous
 *    spacing, hard-wrapped lines reflowed into paragraphs the way markdown
 *    means them, block-level HTML stripped to its text, and task-list
 *    checkboxes. This is what makes a document read as a document.
 *
 * Chat text is rendered block by block (see `markdownSegments`): each finished
 * top-level block is memoized by its source, so a reply that is still
 * streaming re-parses only the block being written instead of the whole reply
 * on every frame. The output is the same as parsing the text in one go.
 */
/** True inside a Sandbox chat, where host file and image previews are unavailable. */
export const MarkdownSession = React.createContext<string | undefined>(undefined);

export const MarkdownSandbox = React.createContext(false);

export function Markdown({ text, doc = false, basePath }: MarkdownProps) {
  if (doc) return <DocMarkdown text={text} basePath={basePath} />;
  return <ChatMarkdown text={text} basePath={basePath} />;
}

/** A document is parsed whole: it is read, not streamed, and its HTML stripping works line by line. */
function DocMarkdown({ text, basePath }: { text: string; basePath?: string }) {
  const blocks = React.useMemo(() => renderWhole(text, { doc: true, basePath }), [text, basePath]);
  return <div className="md-doc text-[14px] leading-7">{blocks}</div>;
}

function ChatMarkdown({ text, basePath }: { text: string; basePath?: string }) {
  const ctx = React.useMemo<Ctx>(() => ({ doc: false, basePath }), [basePath]);
  const segments = markdownSegments(text);
  return (
    <div className="space-y-1 text-[14px] leading-relaxed">
      {segments.map((s) =>
        s.kind === 'code'
          ? <MemoCodeBlock key={s.key} lang={s.lang} code={s.code} />
          : <TextSegment key={s.key} src={s.src} blockKey={s.key} ctx={ctx} />,
      )}
    </div>
  );
}

/** One run of non-code blocks, re-parsed only when its own source changes. */
const TextSegment = React.memo(function TextSegment({ src, blockKey, ctx }: { src: string; blockKey: string; ctx: Ctx }) {
  return <>{renderBlocks(src, blockKey, ctx)}</>;
});

/**
 * The reference renderer: the whole text in one pass. Documents use it
 * directly, and the tests hold the block-split chat renderer to its output.
 */
export function renderWhole(text: string, ctx: Ctx): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const source = ctx.doc ? stripComments(text) : text;
  source.split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      const { lang, code } = fence(part);
      blocks.push(<CodeBlock key={`code-${i}`} lang={lang} code={code} />);
    } else {
      blocks.push(...renderBlocks(part, `b${i}`, ctx));
    }
  });
  return blocks;
}

/** A fenced part's language line and body. */
function fence(part: string): { lang: string; code: string } {
  const nl = part.indexOf('\n');
  const lang = nl > 0 ? part.slice(0, nl).trim() : '';
  const code = nl > 0 ? part.slice(nl + 1) : part;
  return { lang, code: code.replace(/\n$/, '') };
}

export type MarkdownSegment =
  | { kind: 'code'; key: string; lang: string; code: string }
  | { kind: 'text'; key: string; src: string };

/**
 * Split chat markdown into top-level segments that can be rendered, and
 * memoized, independently.
 *
 * Code fences split first, exactly as the whole-text renderer splits them. The
 * text between fences then splits at blank lines: every block kind the parser
 * knows ends at a blank line and nothing carries across one, so rendering the
 * pieces one by one produces the same nodes as rendering the run whole. A
 * segment's key is where it starts, which stays put as text is appended, so a
 * streaming reply keeps every finished segment and re-parses only the last.
 */
export function markdownSegments(text: string): MarkdownSegment[] {
  const out: MarkdownSegment[] = [];
  text.split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push({ kind: 'code', key: `code-${i}`, ...fence(part) });
      return;
    }
    const lines = part.split('\n');
    let start = -1;
    for (let j = 0; j <= lines.length; j++) {
      const blank = j === lines.length || !lines[j].trim();
      if (!blank && start < 0) start = j;
      if (blank && start >= 0) {
        out.push({ kind: 'text', key: `b${i}-${start}`, src: lines.slice(start, j).join('\n') });
        start = -1;
      }
    }
  });
  return out;
}

export interface MarkdownProps {
  text: string;
  /** Render as a document (heading scale, reflowed paragraphs, HTML stripped). */
  doc?: boolean;
  /**
   * Folder the document lives in, so relative links and images can be opened
   * with the OS. Omitted for chat text, which has no home directory.
   */
  basePath?: string;
}

/** Rendering options threaded through the block/inline walk. */
export interface Ctx {
  doc: boolean;
  basePath?: string;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  if (lang.toLowerCase() === 'mermaid') return <MermaidDiagram code={code} />;
  return (
    <div className="group relative my-2">
      <pre
        className="overflow-x-auto rounded-xl border border-line p-3 font-mono text-[13px] leading-relaxed"
        style={{ background: 'var(--surface-2)' }}
      >
        {lang && <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">{lang}</div>}
        <code>{code}</code>
      </pre>
      <button
        onClick={copy}
        title="Copy code"
        className="absolute right-2 top-2 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        style={{ background: 'var(--surface)' }}
      >
        {copied ? '✓ copied' : 'Copy'}
      </button>
    </div>
  );
}

const MemoCodeBlock = React.memo(CodeBlock);

const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

/** Heading typography for document mode, by level. */
const DOC_HEADING: Record<number, string> = {
  1: 'mt-6 mb-3 border-b border-line pb-1.5 text-[22px] font-semibold leading-tight tracking-tight',
  2: 'mt-6 mb-2 text-[18px] font-semibold leading-snug',
  3: 'mt-5 mb-1.5 text-[15px] font-semibold',
  4: 'mt-4 mb-1 text-[13px] font-semibold',
  5: 'mt-3 mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-soft',
  6: 'mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint',
};

/** Drop HTML comments, which markdown hides but a plain reader would show. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Reduce a line of embedded HTML to what a reader cares about: `<img>` becomes
 * markdown image syntax, `<br>` a space, and every other tag is dropped while
 * its text survives. A line that was nothing but layout tags (`<div
 * align="center">`, `</table>`) comes back empty and is treated as blank.
 *
 * Deliberately not an HTML renderer: markdown from anywhere is untrusted, so
 * tags are erased rather than mounted.
 */
function stripHtml(line: string): string {
  if (!line.includes('<')) return line;
  const withImages = line.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    return src ? `![${alt}](${src})` : '';
  });
  return withImages
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .trimEnd();
}

/** Split a markdown table row into trimmed cells (drops the outer pipes). */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

interface ListItem {
  indent: number;
  text: string;
  ordered: boolean;
}

function listItem(line: string): ListItem | null {
  const bullet = BULLET_RE.exec(line);
  if (bullet) return { indent: bullet[1].length, text: bullet[2], ordered: false };
  const ordered = ORDERED_RE.exec(line);
  if (ordered) return { indent: ordered[1].length, text: ordered[2], ordered: true };
  return null;
}

/** True for any line that starts a block of its own, so a paragraph run stops. */
function startsBlock(line: string): boolean {
  return !line.trim() || !!listItem(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || RULE_RE.test(line);
}

/**
 * One flat run of list items folded into a nested list: items more indented than
 * the run's first item become children of the item above them.
 */
function renderList(items: ListItem[], key: string, ctx: Ctx, depth = 0): React.ReactNode {
  const base = items[0].indent;
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    // Everything more indented than the base level belongs to this item.
    let end = i + 1;
    while (end < items.length && items[end].indent > base) end += 1;
    const children = items.slice(i + 1, end);
    // `- [x] done` renders as a checkbox rather than a literal bracket pair.
    const task = TASK_RE.exec(items[i].text);
    nodes.push(
      <li key={`${key}-${i}`} className={task ? 'list-none' : undefined}>
        {task ? (
          <span className="flex items-start gap-1.5">
            <span
              aria-hidden
              className="mt-[3px] shrink-0 text-[11px]"
              style={{ color: task[1] === ' ' ? 'var(--ink-faint)' : 'var(--success)' }}
            >
              {task[1] === ' ' ? '☐' : '☑'}
            </span>
            <span className={task[1] === ' ' ? '' : 'text-ink-soft'}>{inline(task[2], ctx)}</span>
          </span>
        ) : (
          inline(items[i].text, ctx)
        )}
        {children.length > 0 && renderList(children, `${key}-${i}s`, ctx, depth + 1)}
      </li>,
    );
    i = end;
  }
  const className = ctx.doc ? 'my-2 ml-5 space-y-1' : 'ml-4 space-y-0.5';
  return items[0].ordered
    ? <ol key={key} className={className} style={{ listStyleType: depth % 2 ? 'lower-alpha' : 'decimal', paddingLeft: '0.35rem' }}>{nodes}</ol>
    : <ul key={key} className={className} style={{ listStyleType: depth % 2 ? 'circle' : 'disc', paddingLeft: '0.35rem' }}>{nodes}</ul>;
}

/**
 * Scan a (fence-free) chunk of markdown into block-level nodes. Each branch
 * consumes the lines it owns and leaves `i` on the first line it doesn't.
 */
function renderBlocks(src: string, key: string, ctx: Ctx): React.ReactNode[] {
  const lines = (ctx.doc ? src.split('\n').map(stripHtml) : src.split('\n'));
  const out: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // Pipe table: a header row, a |---|---| divider, then body rows.
    if (line.trim().startsWith('|') && TABLE_DIVIDER_RE.test(lines[i + 1] ?? '')) {
      const header = tableCells(line);
      const body: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) { body.push(tableCells(lines[j])); j += 1; }
      out.push(
        <div key={`${key}-t${i}`} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {header.map((h, k) => (
                  <th key={k} className="border-b border-line px-2.5 py-1.5 text-left font-semibold">{inline(h, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c} className="border-b border-line px-2.5 py-1.5 align-top text-ink-soft">{inline(row[c] ?? '', ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (ctx.doc) {
        const Tag = `h${Math.min(level, 6)}` as 'h1';
        out.push(
          <Tag key={`${key}-h${i}`} className={DOC_HEADING[level] ?? DOC_HEADING[6]}>
            {inline(heading[2], ctx)}
          </Tag>,
        );
      } else {
        out.push(
          <div key={`${key}-h${i}`} className={`font-semibold ${level <= 2 ? 'mt-1 text-[15px]' : ''}`}>
            {inline(heading[2], ctx)}
          </div>,
        );
      }
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      out.push(<hr key={`${key}-r${i}`} className={ctx.doc ? 'my-4 border-line' : 'my-2 border-line'} />);
      i += 1;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length) {
        const q = QUOTE_RE.exec(lines[j]);
        if (!q) break;
        quoted.push(q[1]);
        j += 1;
      }
      out.push(
        <blockquote
          key={`${key}-q${i}`}
          className={ctx.doc ? 'my-3 border-l-2 border-accent/40 pl-3 text-ink-soft' : 'my-1 border-l-2 border-line pl-2.5 text-ink-soft'}
        >
          {renderBlocks(quoted.join('\n'), `${key}-q${i}i`, ctx)}
        </blockquote>,
      );
      i = j;
      continue;
    }

    const first = listItem(line);
    if (first) {
      const items: ListItem[] = [];
      let j = i;
      while (j < lines.length) {
        const it = listItem(lines[j]);
        // A same-level switch between bullets and numbers starts a new list.
        if (!it || (it.indent <= first.indent && it.ordered !== first.ordered)) break;
        items.push(it);
        j += 1;
      }
      out.push(renderList(items, `${key}-l${i}`, ctx));
      i = j;
      continue;
    }

    // Paragraph: every line up to the next blank line or block start. Chat keeps
    // the single newlines as breaks (people type that way); a document reflows
    // them, since markdown treats a hard-wrapped paragraph as one paragraph.
    const para: string[] = [line];
    let j = i + 1;
    while (j < lines.length && !startsBlock(lines[j])) { para.push(lines[j]); j += 1; }
    out.push(
      ctx.doc
        ? <p key={`${key}-p${i}`} className="my-2.5">{inline(para.join(' '), ctx)}</p>
        : <p key={`${key}-p${i}`}>{lineBreaks(para, ctx)}</p>,
    );
    i = j;
  }

  return out;
}

/** Render a paragraph's lines with <br/> between them. */
function lineBreaks(lines: string[], ctx: Ctx): React.ReactNode {
  return lines.map((l, k) => (
    <React.Fragment key={k}>
      {k > 0 && <br />}
      {inline(l, ctx)}
    </React.Fragment>
  ));
}

// image | bold | italic | strikethrough | inline code | [text](target) link |
// bare url. Italic deliberately covers only *stars*, not _underscores_, so
// snake_case identifiers in prose survive intact; both delimiters must hug their
// text so arithmetic like `2 * 3 * 4` isn't read as emphasis. A link target is
// either a URL or something that looks like a path or anchor, so `arr[0](x)` in
// prose about code isn't mistaken for a link.
const LINK_TARGET = String.raw`https?:\/\/[^\s)]+|[a-zA-Z]:[\\/][^\s)]+|[.\/#][^\s)]*|[\w.-]+(?:[\\/][^\s)]+|\.[a-zA-Z]{1,8}(?:#[^\s)]*)?)`;
const INLINE_RE = new RegExp(
  [
    String.raw`!\[([^\]]*)\]\(([^\s)]+)\)`,
    String.raw`\*\*([^*]+)\*\*`,
    String.raw`\*([^\s*][^*]*?)\*`,
    String.raw`~~([^~]+)~~`,
    '`([^`]+)`',
    String.raw`\[([^\]]+)\]\((${LINK_TARGET})\)`,
    String.raw`(https?:\/\/[^\s<>"')\]]+)`,
  ].map((alt) => `(?:${alt})`).join('|'),
  'g',
);

function inline(s: string, ctx: Ctx): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  // Each inline walk owns its cursor: nested emphasis must not reset the
  // parent's scan and repeat or skip later links.
  const pattern = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  while ((m = pattern.exec(s))) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    const [, imgAlt, imgSrc, bold, italic, strike, code, linkText, linkHref, bareUrl] = m;
    if (imgSrc !== undefined) {
      nodes.push(<ImageRef key={key++} alt={imgAlt ?? ''} src={imgSrc} basePath={ctx.basePath} />);
    } else if (bold !== undefined) {
      nodes.push(<strong key={key++}>{inline(bold, ctx)}</strong>);
    } else if (italic !== undefined) {
      nodes.push(<em key={key++}>{inline(italic, ctx)}</em>);
    } else if (strike !== undefined) {
      nodes.push(<s key={key++} className="text-ink-faint">{inline(strike, ctx)}</s>);
    } else if (code !== undefined) {
      nodes.push(
        <code key={key++} className="rounded-sm px-1 py-0.5 font-mono text-[13px]" style={{ background: 'var(--surface-2)' }}>
          {code}
        </code>,
      );
    } else if (linkText !== undefined) {
      nodes.push(<Ref key={key++} href={linkHref} basePath={ctx.basePath}>{linkText}</Ref>);
    } else if (bareUrl !== undefined) {
      nodes.push(<Link key={key++} href={bareUrl}>{bareUrl}</Link>);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}

/** Absolute path for a document-relative target (no-op for absolute ones). */
function resolveRef(basePath: string, target: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\')) return target;
  const sep = basePath.includes('\\') ? '\\' : '/';
  const parts = basePath.split(/[\\/]/).filter(Boolean);
  for (const seg of target.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join(sep);
  // Keep a POSIX root; Windows paths already start with a drive letter.
  return basePath.startsWith('/') ? `/${joined}` : joined;
}

/**
 * A markdown link. Web URLs open externally; a relative target (`docs/x.md`,
 * `#section`) only becomes clickable when we know the document's folder,
 * otherwise it reads as plain emphasis instead of a dead link.
 */
function Ref({ href, basePath, children }: { href: string; basePath?: string; children: React.ReactNode }) {
  const sessionId = React.useContext(MarkdownSession);
  const sandbox = React.useContext(MarkdownSandbox);
  if (sandbox && !/^https?:\/\//i.test(href)) return <span title="Host file previews are unavailable in Sandbox">{children} (preview unavailable)</span>;
  if (/^https?:\/\//i.test(href)) return <Link href={href}>{children}</Link>;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return <span>{children}</span>;
  if (href.startsWith('//') || href.startsWith('\\\\')) return <span>{children}</span>;
  if (href.startsWith('#') || (!basePath && !/^(?:[A-Za-z]:[\\/]|\/)/.test(href))) return <span className="text-ink-soft">{children}</span>;
  const target = basePath ? resolveRef(basePath, href) : href;
  return (
    <button
      className="wrap-break-word underline"
      style={{ color: 'var(--accent)' }}
      title={`Open ${target}`}
      onClick={() => { useStore.getState().openFilePane(target, sessionId); }}
    >
      {children}
    </button>
  );
}

/**
 * An image reference. The renderer's CSP allows only same-origin and `data:`
 * images, so a remote or on-disk one can't be shown inline: it renders as a
 * labelled chip that opens the real file instead of a broken image box.
 */
function ImageRef({ alt, src, basePath }: { alt: string; src: string; basePath?: string }) {
  const sessionId = React.useContext(MarkdownSession);
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const remote = /^https?:\/\//i.test(src);
  const unsafe = src.startsWith('//') || src.startsWith('\\\\') || (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src) && !remote);
  const target = unsafe ? null : remote ? src : basePath ? resolveRef(basePath, src) : /^(?:[A-Za-z]:[\\/]|\/)/.test(src) ? src : null;
  const label = alt || src.split(/[\\/]/).pop() || 'image';
  const sandbox = React.useContext(MarkdownSandbox);
  if (sandbox && !remote) return <span title="Host image previews are unavailable in Sandbox">{label} (preview unavailable)</span>;
  if (image) return <img src={image} alt={label} className="my-2 max-h-96 max-w-full rounded-lg border border-line object-contain" />;
  const body = (
    <>
      <span aria-hidden>🖼</span>
      <span className="min-w-0 truncate">{label}{error ? ` · ${error}` : target && !remote ? ' · Load image' : ''}</span>
    </>
  );
  const className = 'my-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line px-2 py-0.5 align-middle text-[12px] text-ink-soft';
  if (!target) return <span className={className} title={src}>{body}</span>;
  return (
    <button
      className={`${className} hover:bg-surface-2 hover:text-ink`}
      title={`Open ${target}`}
      onClick={async () => {
        if (remote) { window.nekko.openPath(target); return; }
        try {
          const file = await window.nekko.readFile(target);
          if (file.imageDataUrl) setImage(file.imageDataUrl);
          else if (/\.svg$/i.test(target) && !file.binary && !file.truncated) {
             useStore.getState().openFilePane(target, sessionId);
           } else setError('Preview unavailable');
        } catch { setError('Could not read image'); }
      }}
    >
      {body}
    </button>
  );
}

/**
 * Markdown is untrusted here - it arrives from model output, and from files and
 * PR bodies the agent read. Every caller happens to pass an http(s) URL today,
 * but the guard lives on the sink so a new caller can't turn a link target into
 * `javascript:`/`data:` script execution inside the renderer.
 */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href, 'about:blank');
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
    return href.replace(/[<>"'`]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return null;
  }
}

export function linkContextActions(href: string): Array<{ label: string; run: () => void }> {
  const safe = safeHref(href);
  if (!safe) return [];
  const actions = [{ label: 'Open in external browser', run: () => { void window.nekko.openPath(safe); } }];
  if (/^https?:\/\//i.test(safe)) {
    actions.push({ label: 'Open in in-app browser', run: () => { useStore.getState().openBrowserPane(safe); } });
  }
  actions.push({ label: 'Copy link', run: () => { void navigator.clipboard.writeText(safe); } });
  return actions;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const safe = safeHref(href);
  if (!safe) return <span className="wrap-break-word text-ink-soft" title={href}>{children}</span>;
  return (
    <>
      <a href={safe} target="_blank" rel="noreferrer" className="wrap-break-word underline" style={{ color: 'var(--accent)' }} onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}>
        {children}
      </a>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        {linkContextActions(safe).map((action) => <ContextAction key={action.label} onClick={() => { setMenu(null); action.run(); }}>{action.label}</ContextAction>)}
      </ContextMenu>}
    </>
  );
}
