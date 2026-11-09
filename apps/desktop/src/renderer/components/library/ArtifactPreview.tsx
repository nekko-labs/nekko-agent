import React from 'react';
import type { ArtifactKind } from '../../artifactsIndex.js';

/** Each kind's color, mixed into the theme's own surfaces so light and dark both hold. */
export const KIND_COLOR: Record<ArtifactKind, string> = {
  doc: '#a78bfa',
  web: '#38bdf8',
  design: '#f472b6',
  diagram: '#34d399',
  data: '#fbbf24',
  office: '#fb923c',
  image: '#a3e635',
};

/** A small stable number from a path, so the same file always gets the same picture. */
export function variantOf(path: string, count: number): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % count;
}

const K = 'var(--k)', DEEP = 'var(--k-deep)';

/** Three drawings per kind. Original line art; no file is read to make them. */
const ART: Record<ArtifactKind, Array<() => React.ReactNode>> = {
  doc: [
    () => <><rect x="26" y="16" width="48" height="66" rx="5" fill={DEEP} /><path d="M34 30h22M34 40h32M34 48h26M34 56h30M34 64h18" stroke={K} strokeWidth="3" strokeLinecap="round" opacity=".85" /></>,
    () => <><rect x="24" y="16" width="52" height="66" rx="5" fill={DEEP} /><rect x="32" y="24" width="36" height="20" rx="3" fill={K} opacity=".4" /><path d="M32 52h36M32 60h28M32 68h32" stroke={K} strokeWidth="3" strokeLinecap="round" opacity=".85" /></>,
    () => <><rect x="30" y="20" width="44" height="62" rx="5" fill={DEEP} opacity=".6" /><rect x="24" y="14" width="44" height="62" rx="5" fill={DEEP} /><path d="M32 28h20M32 38h28M32 46h24M32 54h28" stroke={K} strokeWidth="3" strokeLinecap="round" opacity=".85" /></>,
  ],
  web: [
    () => <><rect x="14" y="20" width="72" height="58" rx="6" fill={DEEP} /><path d="M14 31h72" stroke={K} opacity=".45" /><circle cx="21" cy="25.5" r="1.8" fill={K} /><circle cx="27" cy="25.5" r="1.8" fill={K} /><rect x="22" y="38" width="32" height="6" rx="3" fill={K} /><rect x="22" y="48" width="24" height="3" rx="1.5" fill={K} opacity=".5" /><rect x="60" y="38" width="20" height="32" rx="3" fill={K} opacity=".35" /></>,
    () => <><rect x="14" y="20" width="72" height="58" rx="6" fill={DEEP} /><path d="M14 31h72" stroke={K} opacity=".45" /><circle cx="21" cy="25.5" r="1.8" fill={K} /><circle cx="27" cy="25.5" r="1.8" fill={K} /><rect x="22" y="37" width="56" height="16" rx="3" fill={K} opacity=".4" /><rect x="22" y="58" width="16" height="12" rx="2" fill={K} opacity=".7" /><rect x="42" y="58" width="16" height="12" rx="2" fill={K} opacity=".55" /><rect x="62" y="58" width="16" height="12" rx="2" fill={K} opacity=".4" /></>,
    () => <><rect x="14" y="20" width="72" height="58" rx="6" fill={DEEP} /><path d="M14 31h72M34 31v47" stroke={K} opacity=".45" /><circle cx="21" cy="25.5" r="1.8" fill={K} /><circle cx="27" cy="25.5" r="1.8" fill={K} /><path d="M20 40h8M20 48h8M20 56h8" stroke={K} strokeWidth="3" strokeLinecap="round" opacity=".6" /><rect x="40" y="38" width="38" height="6" rx="3" fill={K} /><path d="M40 52h34M40 60h26" stroke={K} strokeWidth="3" strokeLinecap="round" opacity=".5" /></>,
  ],
  design: [
    () => <><rect x="16" y="18" width="32" height="32" rx="7" fill={K} /><rect x="52" y="18" width="32" height="20" rx="7" fill={K} opacity=".55" /><rect x="52" y="42" width="32" height="40" rx="7" fill={K} opacity=".35" /><rect x="16" y="54" width="32" height="28" rx="7" fill={K} opacity=".7" /></>,
    () => <><rect x="16" y="18" width="68" height="64" rx="8" fill={DEEP} /><circle cx="38" cy="42" r="12" fill={K} opacity=".8" /><rect x="54" y="30" width="22" height="22" rx="4" fill={K} opacity=".45" /><path d="M24 70h52" stroke={K} strokeWidth="4" strokeLinecap="round" opacity=".6" /></>,
    () => <><rect x="16" y="18" width="68" height="64" rx="8" fill={DEEP} /><path d="M26 70 L44 34 L58 56 L66 46 L76 70Z" fill={K} opacity=".55" /><circle cx="66" cy="32" r="6" fill={K} /></>,
  ],
  diagram: [
    () => <><rect x="38" y="14" width="24" height="14" rx="4" fill={K} /><rect x="14" y="64" width="24" height="14" rx="4" fill={K} opacity=".6" /><rect x="62" y="64" width="24" height="14" rx="4" fill={K} opacity=".6" /><path d="M50 28v16M26 64V46h48v18" stroke={K} strokeWidth="2.5" fill="none" /></>,
    () => <><rect x="12" y="40" width="20" height="16" rx="4" fill={K} /><rect x="40" y="40" width="20" height="16" rx="4" fill={K} opacity=".7" /><rect x="68" y="40" width="20" height="16" rx="4" fill={K} opacity=".5" /><path d="M32 48h8M60 48h8" stroke={K} strokeWidth="2.5" /></>,
    () => <><circle cx="50" cy="26" r="9" fill={K} /><circle cx="26" cy="66" r="9" fill={K} opacity=".65" /><circle cx="74" cy="66" r="9" fill={K} opacity=".65" /><path d="M45 33 30 58M55 33l15 25M35 66h30" stroke={K} strokeWidth="2.5" /></>,
  ],
  data: [
    () => <><rect x="20" y="58" width="11" height="22" rx="2" fill={K} opacity=".5" /><rect x="36" y="42" width="11" height="38" rx="2" fill={K} opacity=".7" /><rect x="52" y="28" width="11" height="52" rx="2" fill={K} /><rect x="68" y="48" width="11" height="32" rx="2" fill={K} opacity=".6" /></>,
    () => <><rect x="16" y="20" width="68" height="60" rx="5" fill={DEEP} /><path d="M16 34h68M16 48h68M16 62h68M38 20v60M60 20v60" stroke={K} opacity=".45" /><rect x="16" y="20" width="68" height="14" rx="5" fill={K} opacity=".35" /></>,
    () => <><rect x="16" y="20" width="68" height="60" rx="6" fill={DEEP} /><path d="M22 70 36 52l12 8 14-22 16 10" stroke={K} strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>,
  ],
  office: [
    () => <><rect x="20" y="18" width="60" height="46" rx="5" fill={DEEP} /><rect x="28" y="26" width="44" height="24" rx="3" fill={K} opacity=".45" /><path d="M50 64v12M38 78h24" stroke={K} strokeWidth="3" strokeLinecap="round" /></>,
    () => <><rect x="18" y="18" width="64" height="64" rx="6" fill={DEEP} /><path d="M18 32h64M18 46h64M18 60h64M40 18v64" stroke={K} opacity=".45" /><path d="M48 70V54M58 70V42M68 70V50" stroke={K} strokeWidth="5" strokeLinecap="round" /></>,
    () => <><rect x="24" y="14" width="52" height="70" rx="5" fill={DEEP} /><rect x="32" y="22" width="20" height="5" rx="2.5" fill={K} /><path d="M32 36h36M32 44h36M32 52h28M32 60h36M32 68h20" stroke={K} strokeWidth="2.5" strokeLinecap="round" opacity=".7" /></>,
  ],
  image: [
    () => <><rect x="14" y="18" width="72" height="64" rx="6" fill={DEEP} /><circle cx="64" cy="36" r="7" fill={K} /><path d="M18 78l22-24 14 12 10-8 20 20z" fill={K} opacity=".7" /></>,
    () => <><rect x="14" y="18" width="72" height="64" rx="6" fill={DEEP} /><circle cx="34" cy="38" r="9" fill={K} opacity=".8" /><path d="M18 78 50 46l32 32z" fill={K} opacity=".5" /></>,
    () => <><rect x="20" y="24" width="56" height="56" rx="6" fill={DEEP} opacity=".6" transform="rotate(-8 48 52)" /><rect x="24" y="20" width="56" height="56" rx="6" fill={DEEP} /><circle cx="62" cy="36" r="6" fill={K} /><path d="M28 72l18-20 12 10 8-6 14 16z" fill={K} opacity=".7" /></>,
  ],
};

/**
 * The picture Library shows for a file: drawn from its kind, name and
 * extension. Library never reads a file to draw it.
 */
export function ArtifactPreview({ kind, path, ext, icon = false, className = '', mover }: {
  kind: ArtifactKind;
  path: string;
  ext: string;
  /** A row icon: no extension label, which would be too small to read. */
  icon?: boolean;
  className?: string;
  /** Its transition name when Library animates a layout change. */
  mover?: string;
}) {
  const art = ART[kind][variantOf(path, ART[kind].length)];
  const style = {
    '--k': KIND_COLOR[kind],
    '--k-soft': `color-mix(in srgb, ${KIND_COLOR[kind]} 20%, var(--surface))`,
    '--k-deep': `color-mix(in srgb, ${KIND_COLOR[kind]} 9%, var(--win))`,
  } as React.CSSProperties;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className={`library-preview ${className}`} style={style} data-preview-kind={kind} data-library-mover={mover} data-library-mover-class={mover ? 'library-preview' : undefined}>
      <rect width="100" height="100" fill="var(--k-soft)" />
      {art()}
      {!icon && ext && <text x="92" y="93" textAnchor="end" fontSize="9" fontWeight="700" fill={K} style={{ fontFamily: 'inherit' }}>{ext.slice(0, 5).toUpperCase()}</text>}
    </svg>
  );
}
