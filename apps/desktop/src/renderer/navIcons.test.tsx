import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelsColorIcon, WorkflowsColorIcon } from './navIcons.js';

describe('Models navigation icon', () => {
  it('uses Gentleface brain-gear at rail size with violet and lavender fills', () => {
    const html = renderToStaticMarkup(<ModelsColorIcon className="rail-icon" />);
    expect(html).toContain('data-gentleface-icon="brain-gear"');
    expect(html).toContain('viewBox="0 0 16 16" width="22" height="22" class="rail-icon"');
    expect(html).toContain('fill="#8b5cf6"');
    expect(html).toContain('fill="#a78bfa"');
    expect(html).not.toContain('currentColor');
    expect(html).not.toMatch(/https?:|<image|<use|<script/);
    // Both brain halves, then the gear silhouette and its transparent hub.
    expect(html).toContain('M6 0.172');
    expect(html).toContain('M7 0.172');
    expect(html).toContain('M15.573 9.587');
    expect(html).toContain('M11.5 13');
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).not.toContain('<rect');
  });
});

describe('Scheduled Tasks navigation icon', () => {
  it('uses the Gentleface workflow-clock shape in the rail palette, independent of inherited text color', () => {
    const html = renderToStaticMarkup(<WorkflowsColorIcon className="rail-icon" />);
    expect(html).toContain('data-gentleface-icon="workflow-clock"');
    expect(html).toContain('viewBox="0 0 16 16" width="22" height="22" class="rail-icon"');
    expect(html).toContain('fill="#6366f1"');
    expect(html).toContain('fill="#fbbf24"');
    expect(html).not.toContain('currentColor');
    expect(html).not.toMatch(/https?:|<image|<use|<script/);
    // The clock's filled circular face and cut-out hands are upstream subpaths.
    expect(html).toContain('M13.156 7.316');
    expect(html).toContain('M12 8.5');
    expect(html.match(/<path /g)).toHaveLength(2);
  });
});
