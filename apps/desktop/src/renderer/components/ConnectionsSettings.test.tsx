import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTIONS, type AppSettings } from '@nekko-agent/shared';
import { ConnectionsSettings, statusLine } from './ConnectionsSettings.js';
import { Toggle } from './primitives/Toggle.js';

function toggles(settings: AppSettings, update = vi.fn()) {
  const elements: React.ReactElement<Record<string, any>>[] = [];
  // Render the rows' own elements: Row is a component, so call it to reach its Toggle.
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    if (typeof child.type === 'function' && child.type !== Toggle) return walk((child.type as (p: unknown) => React.ReactNode)(child.props));
    elements.push(child);
    walk(child.props.children);
  });
  walk(<ConnectionsSettings settings={settings} update={update} />);
  return { update, list: elements.filter((e) => e.type === Toggle) };
}

vi.mock('react', async (original) => {
  const React = await original<typeof import('react')>();
  // Rendered outside React here: state stays at its initial value, effects never run.
  return { ...React, useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}], useEffect: () => {} };
});

describe('Settings > Connections', () => {
  it('shows the master switch and every connection with a log button', () => {
    const html = renderToStaticMarkup(<ConnectionsSettings settings={{} as AppSettings} update={() => {}} />);
    expect(html).toContain('All connections off');
    for (const c of CONNECTIONS) expect(html).toContain(`data-connection="${c.id}"`);
    expect(html.match(/Show log/g)).toHaveLength(CONNECTIONS.length);
    expect(html).toContain('no usage or crash reports unless you turn them on');
  });

  it('All connections off saves the switch and greys every row', () => {
    const { list, update } = toggles({} as AppSettings);
    list[0].props.onChange(true);
    expect(update).toHaveBeenCalledWith({ connections: { allOff: true } });
    const off = toggles({ connections: { allOff: true } } as AppSettings).list.slice(1);
    expect(off.every((t) => t.props.disabled && t.props.value === false)).toBe(true);
  });

  it('a row switch adds and removes its id', () => {
    const { list, update } = toggles({ connections: { blocked: ['mcp'] } } as AppSettings);
    const row = (label: string) => list.find((t) => t.props.label === label)!;
    expect(row('MCP servers').props.value).toBe(false);
    row('App updates').props.onChange(false);
    expect(update).toHaveBeenLastCalledWith({ connections: { blocked: ['mcp', 'updates'] } });
    row('MCP servers').props.onChange(true);
    expect(update).toHaveBeenLastCalledWith({ connections: { blocked: [] } });
  });

  it('says how often a connection was used', () => {
    const now = 10_000_000;
    expect(statusLine(undefined, now)).toBe('No contact yet');
    expect(statusLine({ id: 'x', lastAt: now - 180_000, count24h: 42, errors24h: 2, blocked24h: 0, allowed: true }, now)).toBe('Last 3 min ago · 42 in 24 h · 2 failed');
  });
});
