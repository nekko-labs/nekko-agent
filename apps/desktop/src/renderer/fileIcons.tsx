import React from 'react';

/**
 * Lightweight file-type icons without shipping an icon pack: a JSON map of
 * extension/filename → {color, label}, rendered as a small color-tinted chip
 * with a short label (the react-file-icon model). Colors follow the well-known
 * GitHub Linguist / Material Icon Theme palette.
 */

interface Meta { color: string; label: string }

/** Exact-filename matches win over extension (package.json beats .json). */
const BY_NAME: Record<string, Meta> = {
  'package.json': { color: '#cb3837', label: 'NPM' },
  'package-lock.json': { color: '#787878', label: 'LOCK' },
  'yarn.lock': { color: '#787878', label: 'LOCK' },
  'pnpm-lock.yaml': { color: '#787878', label: 'LOCK' },
  'tsconfig.json': { color: '#3178c6', label: 'TS' },
  dockerfile: { color: '#2496ed', label: 'DOCK' },
  'docker-compose.yml': { color: '#2496ed', label: 'DOCK' },
  '.gitignore': { color: '#f14e32', label: 'GIT' },
  '.gitattributes': { color: '#f14e32', label: 'GIT' },
  'readme.md': { color: '#42a5f5', label: 'MD' },
  license: { color: '#cb9b00', label: 'LIC' },
  'license.md': { color: '#cb9b00', label: 'LIC' },
  '.env': { color: '#fdd835', label: 'ENV' },
  makefile: { color: '#6d8086', label: 'MK' },
};

const BY_EXT: Record<string, Meta> = {
  js: { color: '#f1e05a', label: 'JS' }, mjs: { color: '#f1e05a', label: 'JS' }, cjs: { color: '#f1e05a', label: 'JS' },
  ts: { color: '#3178c6', label: 'TS' },
  jsx: { color: '#f1e05a', label: 'JSX' }, tsx: { color: '#3178c6', label: 'TSX' },
  json: { color: '#cbcb41', label: 'JSON' },
  html: { color: '#e34c26', label: 'HTML' }, htm: { color: '#e34c26', label: 'HTML' },
  css: { color: '#663399', label: 'CSS' }, scss: { color: '#c6538c', label: 'SASS' }, sass: { color: '#c6538c', label: 'SASS' },
  md: { color: '#42a5f5', label: 'MD' }, markdown: { color: '#42a5f5', label: 'MD' },
  py: { color: '#3572A5', label: 'PY' },
  rb: { color: '#701516', label: 'RB' },
  go: { color: '#00ADD8', label: 'GO' },
  rs: { color: '#dea584', label: 'RS' },
  java: { color: '#b07219', label: 'JAVA' },
  c: { color: '#555555', label: 'C' }, h: { color: '#555555', label: 'H' },
  cpp: { color: '#f34b7d', label: 'C++' }, cc: { color: '#f34b7d', label: 'C++' }, hpp: { color: '#f34b7d', label: 'H++' },
  cs: { color: '#178600', label: 'C#' },
  php: { color: '#4F5D95', label: 'PHP' },
  sh: { color: '#89e051', label: 'SH' }, bash: { color: '#89e051', label: 'SH' }, zsh: { color: '#89e051', label: 'SH' },
  yml: { color: '#cb171e', label: 'YML' }, yaml: { color: '#cb171e', label: 'YML' }, toml: { color: '#9c4221', label: 'TOML' },
  xml: { color: '#0060ac', label: 'XML' },
  sql: { color: '#e38c00', label: 'SQL' },
  txt: { color: '#9e9e9e', label: 'TXT' },
  png: { color: '#a074c4', label: 'IMG' }, jpg: { color: '#a074c4', label: 'IMG' }, jpeg: { color: '#a074c4', label: 'IMG' },
  gif: { color: '#a074c4', label: 'IMG' }, webp: { color: '#a074c4', label: 'IMG' }, bmp: { color: '#a074c4', label: 'IMG' },
  svg: { color: '#ffb13b', label: 'SVG' },
  pdf: { color: '#e5252a', label: 'PDF' },
  zip: { color: '#afb42b', label: 'ZIP' }, tar: { color: '#afb42b', label: 'TAR' }, gz: { color: '#afb42b', label: 'GZ' },
  lock: { color: '#787878', label: 'LOCK' }, env: { color: '#fdd835', label: 'ENV' },
  csv: { color: '#27ae60', label: 'CSV' }, tsv: { color: '#27ae60', label: 'TSV' },
  swift: { color: '#f05138', label: 'SW' }, kt: { color: '#a97bff', label: 'KT' }, kts: { color: '#a97bff', label: 'KT' },
  m: { color: '#438eff', label: 'M' }, mm: { color: '#438eff', label: 'MM' }, gradle: { color: '#02303a', label: 'GR' },
  vue: { color: '#41b883', label: 'VUE' }, svelte: { color: '#ff3e00', label: 'SV' }, plist: { color: '#9e9e9e', label: 'PL' },
};

const GENERIC: Meta = { color: '#9e9e9e', label: '' };

export function fileMeta(name: string): Meta {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] ?? (ext ? { color: '#9e9e9e', label: ext.slice(0, 4).toUpperCase() } : GENERIC);
}

/** A small color-tinted chip labelled with the file type. */
export function FileTypeIcon({ name, size = 16 }: { name: string; size?: number }) {
  const m = fileMeta(name);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-[3px] font-bold leading-none"
      style={{
        width: size,
        height: size,
        background: `${m.color}22`,
        color: m.color,
        fontSize: Math.max(6, Math.round(size * 0.42)),
      }}
      aria-hidden
    >
      {m.label || '•'}
    </span>
  );
}
