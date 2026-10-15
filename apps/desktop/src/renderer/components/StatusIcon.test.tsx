import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../store.js', () => ({ useStore: () => undefined }));
vi.mock('../useGitStatus.js', () => ({ useGitStatus: () => null }));
import { StatusIcon, agentStatusOfLane } from './WorkspaceCard.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('agent status glyphs', () => {
  it('maps board lanes to the sidebar glyphs', () => {
    expect(agentStatusOfLane('working')).toBe('working');
    expect(agentStatusOfLane('idle')).toBeUndefined();
    expect(agentStatusOfLane('needs-you', 'question')).toBe('input');
    expect(agentStatusOfLane('needs-you', 'approval')).toBe('input');
    expect(agentStatusOfLane('needs-you', 'interrupted')).toBe('error');
  });

  it('draws a green rocket while working and Zz when idle, never a bare dot', () => {
    const working = renderToStaticMarkup(<StatusIcon status="working" />);
    expect(working).toContain('status-rocket');
    expect(working).toContain('rocket-flame');
    const idle = renderToStaticMarkup(<StatusIcon status={undefined} />);
    expect(idle).toContain('aria-label="Done, idle"');
    expect(idle).not.toContain('rounded-full');
  });

  it('uses the glyphs in wall window strips and the wall composer', () => {
    // The wall passes the status as a value (memo-friendly); ChatPane draws the glyph.
    expect(source('./CommandWall.tsx')).toContain("status={agentStatus ?? 'idle'}");
    expect(source('./CommandWall.tsx')).toContain('<span data-agent-status><StatusIcon status={agentStatus} /></span><NumberedAgentIcon');
    expect(source('./ChatPane.tsx')).not.toContain('agent-footer-status');
    expect(source('./WallComposer.tsx')).toContain('<StatusIcon status={agent.glyph} />');
    expect(source('./WallComposer.tsx')).not.toContain('animate-pulse rounded-full');
  });
});

describe('wall chat chrome', () => {
  it('never draws a second title row inside a wall window', () => {
    const chat = source('./ChatPane.tsx');
    expect(chat).toContain('if (framed || inWall) {');
    expect(chat).toContain('inWall={commandCenter}');
  });

  it('draws no empty strip under the wall composer', () => {
    expect(source('./ChatPane.tsx')).toContain("surface === 'composer' ? 'shrink-0' : 'shrink-0 border-t border-line bg-surface px-3 py-1.5'");
  });
});
