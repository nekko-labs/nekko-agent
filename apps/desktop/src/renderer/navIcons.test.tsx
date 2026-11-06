import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkflowsColorIcon } from './navIcons.js';

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
