import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TerminalViewer } from '@nekko-agent/shared';
import { TerminalViewersBadge, ViewersBadge, applyViewersEvent, viewersLabel } from './TerminalViewersBadge.js';

const phone = (id: string, name?: string): TerminalViewer => ({ id, kind: 'phone', name, since: 1 });

describe('terminal viewers badge', () => {
  it('says nothing while only the desktop is watching', () => {
    expect(viewersLabel([])).toBeNull();
    expect(renderToStaticMarkup(<ViewersBadge viewers={[]} />)).toBe('');
    expect(renderToStaticMarkup(<TerminalViewersBadge terminalId="term_1" />)).toBe('');
  });

  it('names the phone that is attached', () => {
    expect(viewersLabel([phone('d1')])).toBe('Phone attached');
    expect(viewersLabel([phone('d1', "Philip's iPhone")])).toBe("Philip's iPhone attached");
    expect(viewersLabel([phone('d1'), phone('d2')])).toBe('2 phones attached');
    expect(viewersLabel([phone('d1'), { id: 'x', kind: 'web', since: 1 }])).toBe('2 remote viewers attached');
    expect(viewersLabel([{ id: 'x', kind: 'web', since: 1 }])).toBe('Remote viewer attached');
  });

  it('renders a status badge with every viewer in its tooltip', () => {
    const html = renderToStaticMarkup(<TerminalViewersBadge terminalId="term_1" initial={[phone('d1', 'iPhone'), phone('d2')]} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('2 phones attached');
    expect(html).toContain('Watching this terminal remotely: iPhone, A phone');
  });

  it('follows terminal:viewers for its own terminal only', () => {
    const before = [phone('d1')];
    expect(applyViewersEvent('term_1', before, { terminalId: 'term_2', viewers: [] })).toBe(before);
    expect(applyViewersEvent('term_1', before, { terminalId: 'term_1', viewers: [] })).toEqual([]);
    const after = applyViewersEvent('term_1', [], { terminalId: 'term_1', viewers: [phone('d3', 'Pixel')] });
    expect(viewersLabel(after)).toBe('Pixel attached');
  });
});
