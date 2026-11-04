import type { HLJSApi } from 'highlight.js';

/** Beyond this the editor stays plain: re-highlighting per keystroke would lag typing. */
export const HIGHLIGHT_MAX_CHARS = 200_000;
/** How much of an unrecognised file auto-detection reads. */
const SNIFF_CHARS = 4_000;

/** Whole file names highlight.js can't infer from an extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  justfile: 'makefile',
  procfile: 'yaml',
  '.gitignore': 'bash',
  '.gitattributes': 'bash',
  '.dockerignore': 'bash',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
};

/** Extensions whose highlight.js alias is missing or wrong. */
const BY_EXT: Record<string, string> = {
  mts: 'typescript',
  cts: 'typescript',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  csproj: 'xml',
  props: 'xml',
  targets: 'xml',
  plist: 'xml',
  xaml: 'xml',
  svg: 'xml',
  env: 'bash',
  zsh: 'bash',
  fish: 'bash',
  psm1: 'powershell',
  psd1: 'powershell',
  mdx: 'markdown',
  gql: 'graphql',
  mmd: 'plaintext',
  mermaid: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
};

let api: Promise<HLJSApi> | null = null;

/** highlight.js and its ~190 grammars, loaded the first time a file opens. */
export function loadHighlighter(): Promise<HLJSApi> {
  api ??= import('highlight.js').then((m) => m.default);
  return api;
}

function baseName(path: string): string {
  return (path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path).toLowerCase();
}

/**
 * The highlight.js language for a file, from its name, its extension, a
 * `.env.local`-style compound, or (failing those) a sniff of its contents.
 * Null means plain text.
 */
export function detectLanguage(hljs: HLJSApi, path: string, content: string): string | null {
  const name = baseName(path);
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('.env') || name.endsWith('.env')) return 'bash';
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (ext) {
    const mapped = BY_EXT[ext];
    if (mapped) return mapped === 'plaintext' ? null : mapped;
    if (hljs.getLanguage(ext)) return ext;
  }
  return sniff(hljs, content);
}

function sniff(hljs: HLJSApi, content: string): string | null {
  const head = content.slice(0, SNIFF_CHARS);
  const shebang = /^#!.*\b(node|deno|bun|python[0-9.]*|ruby|perl|php|bash|sh|zsh|pwsh)\b/.exec(head);
  if (shebang) {
    const tool = shebang[1].replace(/[0-9.]+$/, '');
    return ({ node: 'javascript', deno: 'typescript', bun: 'javascript', sh: 'bash', zsh: 'bash', pwsh: 'powershell' } as Record<string, string>)[tool] ?? tool;
  }
  if (!head.trim()) return null;
  const guess = hljs.highlightAuto(head);
  // A weak guess paints prose in random colours; plain text reads better.
  return guess.language && guess.relevance >= 5 ? guess.language : null;
}

/** The display name of a highlight.js language id ("TypeScript"). */
export function languageName(hljs: HLJSApi, id: string | null): string {
  if (!id) return 'Plain text';
  return hljs.getLanguage(id)?.name ?? id;
}

/** Escaped, token-wrapped HTML for the overlay; highlight.js escapes the source itself. */
export function highlightHtml(hljs: HLJSApi, code: string, language: string): string {
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
