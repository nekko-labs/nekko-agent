import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(function () { Object.assign(globalThis, { window: {}, localStorage: { getItem: function () { return null; } } }); });
import { ArtifactPreview, diagramDocument, isolatedDocument, MermaidDiagram, ZoomFrame } from './ArtifactPreview.js';
import { Markdown } from './Markdown.js';

describe('artifact previews', () => {
  it('puts network and app isolation policy before untrusted content', () => {
    const html = isolatedDocument('<script>fetch("https://example.com")</script>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    for (const policy of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(html).toContain(policy);
    expect(html).not.toContain('allow-same-origin');
  });
  it('starts with scripts disabled and exposes responsive viewport controls', () => {
    const html = renderToStaticMarkup(<ArtifactPreview source="<h1>Design</h1>" />);
    expect(html).toContain('sandbox=""');
    expect(html).toContain('Open interactive preview');
    expect(html).toContain('375px');
    expect(html).toContain('1280px');
  });
  it('keeps diagram source available before async rendering', () => {
    expect(renderToStaticMarkup(<MermaidDiagram code="graph TD; A-->B" />)).toContain('Mermaid source');
    expect(renderToStaticMarkup(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />)).toContain('Rendering diagram');
  });
  it('keeps every diagram frame scriptless and zooms the frame from outside', () => {
    const doc = diagramDocument('<svg/>');
    expect(doc).not.toContain('<script');
    expect(doc).toContain("connect-src 'none'");
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<svg'));
    const frame = renderToStaticMarkup(<ZoomFrame srcDoc={doc} title="t" />);
    expect(frame).toContain('sandbox=""');
    expect(frame).toContain('pointer-events:none');
    expect(frame).toContain('scale(1)');
    // The full-window overlay is not mounted until the user asks for it.
    expect(renderToStaticMarkup(<MermaidDiagram code="graph TD; A-->B" />)).not.toContain('data-mermaid-fullscreen');
  });
  it('does not read or fetch an image during message rendering', () => {
    const html = renderToStaticMarkup(<Markdown text="![Evidence](/project/shot.png)" />);
    expect(html).toContain('Loading image…');
    expect(html).toContain('Open source');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
  });
  it('recognizes generated artifact links in relative folders and Windows paths', () => {
    expect(renderToStaticMarkup(<Markdown text="[Download the editable SVG](nekko-designs/autumn-spooky-cat.svg)" basePath="/project" />)).toContain('Open /project/nekko-designs/autumn-spooky-cat.svg');
    expect(renderToStaticMarkup(<Markdown text="[Art](C:/project/cat.svg)" />)).toContain('Open C:/project/cat.svg');
    expect(renderToStaticMarkup(<Markdown text="arr[0](x)" />)).not.toContain('<button');
  });
  it('opens local artifacts but rejects executable and network-share targets', () => {
    expect(renderToStaticMarkup(<Markdown text="[Report](/project/report.md)" />)).toContain('Open /project/report.md');
    for (const path of ['javascript:alert', 'data:text/html,hello', '//server/share']) {
      expect(renderToStaticMarkup(<Markdown text={`[bad](${path})`} basePath="/project" />)).not.toContain('<button');
    }
  });
});
