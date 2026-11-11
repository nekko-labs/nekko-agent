import React from 'react';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactsColorIcon, AutomationsColorIcon, ModelsColorIcon } from './navIcons.js';

// Hash the joined path data so recoloring cannot accidentally redraw upstream geometry.
const geometryHash = (html: string) => createHash('sha256').update(
  [...html.matchAll(/ d="([^"]+)"/g)].map(match => match[1]).join(''),
).digest('hex');

for (const { label, Icon, glyph, paths, hash, fills } of [
  { label: 'Library', Icon: ArtifactsColorIcon, glyph: 'grid', paths: 4,
    hash: 'f68a912f1b5cbd4f50e8d687ed31b20c54e615b3f783b32568b021ff049e5b2b', fills: ['#0ea5e9', '#38bdf8', '#fbbf24'] },
  { label: 'Models', Icon: ModelsColorIcon, glyph: 'brain-circuit', paths: 1,
    hash: '7e3277ea8b49e859f3caec60698731e75e0586234d54d1dd237151ccb5bd7a7e', fills: ['#8b5cf6'] },
  { label: 'Automations', Icon: AutomationsColorIcon, glyph: 'bolt', paths: 1,
    hash: '512b4716ab72b8714bd8e855f5412a2ad773e7f723a754805c35739cd3b04b9b', fills: ['#fbbf24'] },
]) {
  describe(label + ' navigation icon', () => {
    it('uses the exact Gentleface solid-round geometry at rail size in its existing palette', () => {
      const html = renderToStaticMarkup(<Icon className="rail-icon" />);
      expect(html).toContain('data-gentleface-icon="' + glyph + '"');
      expect(html).toContain('viewBox="0 0 16 16" width="22" height="22" class="rail-icon"');
      for (const fill of fills) expect(html).toContain('fill="' + fill + '"');
      expect(html).not.toContain('currentColor');
      expect(html).not.toMatch(/https?:|<image|<use|<script/);
      expect(html.match(/<path /g)).toHaveLength(paths);
      expect(geometryHash(html)).toBe(hash);
    });
  });
}
