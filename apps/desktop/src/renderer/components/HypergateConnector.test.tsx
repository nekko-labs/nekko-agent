import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import type { HypergateInfo } from '@nekko-agent/shared';
import { HypergateRow, McpServersGroup, mcpServerWhere, type HypergatePhase } from './HypergateConnector.js';

const noop = () => {};
const INFO: HypergateInfo = { url: 'http://localhost:7777/mcp', servers: 3, version: '1.30.0', port: 7777 };
const row = (phase: HypergatePhase, saved: boolean, info: HypergateInfo | null | undefined, error?: string) =>
  renderToStaticMarkup(
    <HypergateRow phase={phase} saved={saved} info={info} error={error} onCheck={noop} onStart={noop} onOpen={noop} onDisconnect={noop} />,
  );

describe('the Hypergate row', () => {
  it('carries the Nekko Labs tag in every phase', () => {
    for (const phase of ['idle', 'missing', 'stopped'] as const) {
      const html = row(phase, false, null);
      expect(html).toContain('>Nekko Labs<');
      expect(html).toContain('title="Made by Nekko Labs"');
    }
  });

  it('starts as one Connect button that checks first', () => {
    const html = row('idle', false, null);
    expect(html).toContain('>Connect<');
    expect(html).toContain('behind one endpoint');
    expect(row('checking', false, null)).toContain('Looking for Hypergate on this computer');
    expect(row('checking', false, null)).toContain('disabled');
  });

  it('says when Hypergate is not installed, with a way to get it', () => {
    const html = row('missing', false, null);
    expect(html).toContain('Not installed on this computer');
    expect(html).toContain('Get Hypergate');
    expect(html).toContain('Check again');
  });

  it('offers Start when it is installed but not running', () => {
    const html = row('stopped', false, null);
    expect(html).toContain('Installed, not running');
    expect(html).toContain('Start Hypergate');
    expect(row('starting', false, null)).toContain('Starting Hypergate');
  });

  it('shows the connected status with the version and server count', () => {
    const html = row('idle', true, INFO);
    expect(html).toContain('Connected · v1.30.0 · 3 servers');
    expect(html).toContain('>Open<');
    expect(html).toContain('>Disconnect<');
    expect(row('idle', true, { ...INFO, servers: 1 })).toContain('1 server<');
  });

  it('offers Start on a saved gateway whose daemon is down', () => {
    const html = row('idle', true, null);
    expect(html).toContain('Connected, but Hypergate is not running');
    expect(html).toContain('Start Hypergate');
    expect(html).not.toContain('>Open<');
  });

  it('shows an error under the row', () => {
    expect(row('stopped', false, null, 'Could not start Hypergate: denied')).toContain('role="alert"');
  });
});

describe('the MCP servers group', () => {
  it('lists configured servers without the Hypergate gateway, and never their arguments or token', () => {
    const html = renderToStaticMarkup(
      <McpServersGroup
        list={[
          { id: 'hypergate', name: 'Hypergate', command: '', args: [], url: 'http://localhost:7777/mcp', token: 'secret-1', enabled: true },
          { id: 'fs', name: 'filesystem', command: 'npx', args: ['--api-key', 'secret-2'], enabled: true },
          { id: 'web', name: 'search', command: '', args: [], url: 'https://mcp.example.com/sse?k=secret-3', token: 'secret-4', enabled: false },
        ]}
      />,
    );
    expect(html).toContain('>MCP servers<');
    expect(html).toContain('filesystem');
    expect(html).toContain('>npx<');
    expect(html).toContain('Turned off in Settings');
    expect(html).not.toContain('>Hypergate<');
    expect(html).not.toContain('secret');
  });

  it('says how to add one when there are none', () => {
    expect(renderToStaticMarkup(<McpServersGroup list={undefined} />)).toContain('No MCP servers yet');
  });

  it('names where a server runs', () => {
    expect(mcpServerWhere({ id: 'a', name: 'a', command: '', args: [], url: 'https://mcp.example.com:8443/x?token=t', enabled: true })).toBe('mcp.example.com:8443');
    expect(mcpServerWhere({ id: 'b', name: 'b', command: 'uvx', args: ['x'], enabled: true })).toBe('uvx');
    expect(mcpServerWhere({ id: 'c', name: 'c', command: '', args: [], url: 'not a url', enabled: true })).toBe('Remote server');
  });
});
