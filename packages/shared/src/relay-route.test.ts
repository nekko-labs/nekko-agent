import { describe, expect, it } from 'vitest';
import { isTailscaleIPv4, relayHost, relayRoute, relayUrlProblem } from './relay-route.js';

describe('relayRoute', () => {
  it('names the path the way the phone does (RelayRoute.swift)', () => {
    expect(relayRoute('ws://my-mac.tail1234.ts.net:4400')).toBe('tailscale');
    expect(relayRoute('ws://100.101.102.103:4400')).toBe('tailscale');
    expect(relayRoute('ws://[fd7a:115c:a1e0::1]:4400')).toBe('tailscale');
    expect(relayRoute('ws://192.168.1.20:4400')).toBe('lan');
    expect(relayRoute('ws://10.0.0.5')).toBe('lan');
    expect(relayRoute('ws://172.16.0.1')).toBe('lan');
    expect(relayRoute('ws://169.254.3.4')).toBe('lan');
    expect(relayRoute('ws://studio.local:4400')).toBe('lan');
    expect(relayRoute('ws://[fe80::1]:4400')).toBe('lan');
    expect(relayRoute('ws://localhost:4400')).toBe('loopback');
    expect(relayRoute('ws://127.0.0.1:4400')).toBe('loopback');
    expect(relayRoute('ws://[::1]:4400')).toBe('loopback');
    expect(relayRoute('wss://nekko-agent-relay.fly.dev')).toBe('internet');
    expect(relayRoute('ws://172.32.0.1')).toBe('internet');
    expect(relayRoute('ws://100.128.0.1')).toBe('internet');
    // A name that merely contains ts.net is not a tailnet name.
    expect(relayRoute('ws://ts.net.example.com')).toBe('internet');
  });

  it('reads the host past userinfo, ports, paths and brackets', () => {
    expect(relayHost('wss://u:p@Relay.Example.com:443/relay?x=1')).toBe('relay.example.com');
    expect(relayHost('ws://[FD7A:115C:A1E0::5]:4400/')).toBe('fd7a:115c:a1e0::5');
    expect(relayHost('ws://host/path@not-userinfo')).toBe('host');
    expect(relayHost('  ws://h  ')).toBe('h');
  });

  it('knows the Tailscale range exactly', () => {
    expect(isTailscaleIPv4('100.64.0.0')).toBe(true);
    expect(isTailscaleIPv4('100.127.255.255')).toBe(true);
    expect(isTailscaleIPv4('100.63.255.255')).toBe(false);
    expect(isTailscaleIPv4('100.128.0.0')).toBe(false);
    expect(isTailscaleIPv4('100.64.0')).toBe(false);
    expect(isTailscaleIPv4('100.64.0.256')).toBe(false);
  });
});

describe('relayUrlProblem', () => {
  it('allows wss anywhere and ws only on private networks', () => {
    expect(relayUrlProblem('wss://nekko-agent-relay.fly.dev')).toBeUndefined();
    expect(relayUrlProblem('ws://my-mac.tail1234.ts.net:4400')).toBeUndefined();
    expect(relayUrlProblem('ws://192.168.1.20:4400')).toBeUndefined();
    expect(relayUrlProblem('ws://relay.example.com')).toMatch(/not encrypted/);
    expect(relayUrlProblem('WS://8.8.8.8:4400')).toMatch(/not encrypted/);
  });

  it('refuses things that are not relay addresses', () => {
    expect(relayUrlProblem('')).toMatch(/starts with wss/);
    expect(relayUrlProblem('https://relay.example.com')).toMatch(/starts with wss/);
    expect(relayUrlProblem('ws://')).toMatch(/starts with wss/);
  });
});
