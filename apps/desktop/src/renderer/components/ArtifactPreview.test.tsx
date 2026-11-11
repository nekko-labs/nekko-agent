import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(function () { Object.assign(globalThis, { window: {}, localStorage: { getItem: function () { return null; } } }); });
import { ArtifactPreview, diagramDocument, isolatedDocument, MermaidDiagram, SERVED_PREVIEW_SANDBOX, ZoomFrame } from './ArtifactPreview.js';
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
  it('serves a page with its folder when the host can, with the internet off', () => {
    const win = globalThis.window as unknown as { nekko?: unknown };
    win.nekko = { serveHtmlPreview: vi.fn(), releaseHtmlPreview: vi.fn() };
    try {
      const html = renderToStaticMarkup(<ArtifactPreview source="<h1>Design</h1>" path="/d/site/index.html" />);
      expect(html).toContain('data-served-preview');
      expect(html).toMatch(/aria-pressed="false"[^>]*data-preview-internet/);
      expect(html).toContain('Load from internet');
      expect(html).not.toContain('Open interactive preview');
      // An SVG, or a host with nothing to serve it, keeps the scriptless frame.
      expect(renderToStaticMarkup(<ArtifactPreview source="<svg/>" path="/d/site/logo.svg" />)).toContain('sandbox=""');
      win.nekko = {};
      expect(renderToStaticMarkup(<ArtifactPreview source="<h1>Design</h1>" path="/d/site/index.html" />)).toContain('sandbox=""');
    } finally {
      delete win.nekko;
    }
  });
  it('gives a served page scripts but never the app origin, popups or top navigation', () => {
    expect(SERVED_PREVIEW_SANDBOX.split(' ')).toContain('allow-scripts');
    for (const token of ['allow-same-origin', 'allow-popups', 'allow-top-navigation']) expect(SERVED_PREVIEW_SANDBOX).not.toContain(token);
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
  it('uses a transparent, scriptless diagram document on a borderless dotted host', () => {
    const doc = diagramDocument('<svg/>');
    expect(doc).toContain('background:transparent');
    expect(doc).not.toContain('background:#fff');
    const html = renderToStaticMarkup(<MermaidDiagram code="graph TD; A-->B" />);
    expect(html).toContain('diagram-canvas diagram-card');
    expect(html).not.toContain('border border-line p-3');
    const zoom = renderToStaticMarkup(<ZoomFrame srcDoc={doc} title="t" />);
    expect(zoom).toContain('diagram-canvas');
    expect(zoom).not.toContain('bg-white');
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
