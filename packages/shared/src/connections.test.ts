import { describe, expect, it } from 'vitest';
import { CONNECTION_GROUPS, CONNECTIONS, connectionAllowed, withConnection } from './connections.js';

describe('connections', () => {
  it('lists each connection once, in a known group', () => {
    const ids = CONNECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(CONNECTION_GROUPS.map((g) => g.id));
    for (const c of CONNECTIONS) expect(groups.has(c.group)).toBe(true);
  });

  it('applies All connections off over each switch', () => {
    expect(connectionAllowed(undefined, 'updates')).toBe(true);
    expect(connectionAllowed({ allOff: true }, 'updates')).toBe(false);
    const off = withConnection(undefined, 'mcp', false);
    expect(off).toEqual({ blocked: ['mcp'] });
    expect(connectionAllowed(off, 'mcp')).toBe(false);
    expect(connectionAllowed(off, 'updates')).toBe(true);
    expect(withConnection({ ...off, allOff: true }, 'mcp', true)).toEqual({ allOff: true, blocked: [] });
    expect(withConnection(off, 'mcp', false).blocked).toEqual(['mcp']);
  });
});
