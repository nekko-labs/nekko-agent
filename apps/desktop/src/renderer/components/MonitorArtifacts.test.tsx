import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./ChatArtifacts.js', () => ({ ChatArtifacts: () => <div>Artifact cards</div> }));
import { MonitorArtifacts } from './MonitorArtifacts.js';

describe('monitor artifacts section', () => {
  it('starts collapsed with a zero count and a persistent accessible status region', () => {
    const markup = renderToStaticMarkup(<MonitorArtifacts sessionId="s" artifacts={[]} hydrated />);
    expect(markup).not.toContain('open=""');
    expect(markup).toContain('>0</span>');
    expect(markup).toContain('No artifacts yet.');
    expect(markup).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(markup).not.toContain('New artifact');
  });

  it('renders hydrated history without announcing it', () => {
    const markup = renderToStaticMarkup(<MonitorArtifacts sessionId="s" artifacts={[{ path: '/history.md', filename: 'history.md', title: 'History' }]} hydrated />);
    expect(markup).toContain('>1</span>');
    expect(markup).toContain('Artifact cards');
    expect(markup).not.toContain('New artifact');
    expect(markup).not.toContain('open=""');
  });

  it('wires discovery only to the native disclosure and guards missing or mismatched hydration', () => {
    const section = readFileSync(new URL('./MonitorArtifacts.tsx', import.meta.url), 'utf8');
    const rail = readFileSync(new URL('./PlanRail.tsx', import.meta.url), 'utf8');
    expect(section).toContain('details.current.open = true');
    expect(section).toContain('discovery.dispose()');
    expect(section).toContain('hydrated ? artifacts.map(artifact => artifact.path) : null');
    expect(section).not.toMatch(/useStore|setInterval|onToggle|open=|animate-/);
    expect(rail).toContain('<MonitorArtifacts key={sessionId}');
    expect(rail).toContain('hydrated={!!session && session.id === sessionId && Array.isArray(session.messages)}');
  });
});
