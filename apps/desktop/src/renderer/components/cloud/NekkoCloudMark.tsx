import type { ReactNode } from 'react';

/**
 * The Nekko Cloud mark (#3190): a cloud outline with two wide, round-tipped
 * ears out at the edges of its top lobe and caret eyes, and nothing else of a
 * cat (ears widened 2026-11-23). Line drawing in --ink on
 * --surface. It hops a little every few seconds (cloud.css `nc-hop`, still
 * with reduced motion).
 *
 * `NekkoCloudMarkPaths` draws it in a 64x48 box for use inside another SVG;
 * `NekkoCloudMark` is the standalone icon.
 */
export const NEKKO_CLOUD_PATH = 'M16 40 A9 9 0 1 1 19 22.5 A13 13 0 0 1 19.5 20.4 L16.4 11.8 Q15.6 9.2 18.4 9.6 L25.2 13 A13 13 0 0 1 38.8 13 L45.6 9.6 Q48.4 9.2 47.6 11.8 L44.5 20.4 A13 13 0 0 1 45 22.5 A9 9 0 1 1 48 40 Z';
export const NEKKO_CLOUD_EYES = 'M23.5 29.5 L26.5 26 L29.5 29.5 M34.5 29.5 L37.5 26 L40.5 29.5';

export function NekkoCloudMarkPaths({ hop = true, children }: { hop?: boolean; children?: ReactNode }) {
  return (
    <g className={hop ? 'nc-hop' : undefined} data-part="nekko-cloud">
      <path className="nc-cloud" d={NEKKO_CLOUD_PATH} />
      <path className="nc-eyes" d={NEKKO_CLOUD_EYES} />
      {children}
    </g>
  );
}

export function NekkoCloudMark({ size = 32, hop = true, title }: { size?: number; hop?: boolean; title?: string }) {
  return (
    <svg className="nc-mark" viewBox="0 0 64 48" width={size} height={(size * 48) / 64} overflow="visible"
      role={title ? 'img' : 'presentation'} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <NekkoCloudMarkPaths hop={hop} />
    </svg>
  );
}
