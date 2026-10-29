import { describe, expect, it, vi } from 'vitest';
import { pairingBase } from './RemoteAccess.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

// T197: a QR from the dev desktop app carried http://localhost:5173/?relay=…, which the
// iPhone camera opened as the phone's own localhost ("address is invalid").
const at = (url: string) => {
  const u = new URL(url);
  return { protocol: u.protocol, hostname: u.hostname, origin: u.origin };
};

describe('pairingBase', () => {
  it('uses the app scheme on a loopback origin', () => {
    expect(pairingBase(at('http://localhost:5173/'))).toBe('nekko-agent-pair:');
    expect(pairingBase(at('http://127.0.0.1:4317/'))).toBe('nekko-agent-pair:');
    expect(pairingBase(at('http://[::1]:4317/'))).toBe('nekko-agent-pair:');
  });

  it('uses the app scheme in the packaged desktop app', () => {
    expect(pairingBase({ protocol: 'file:', hostname: '', origin: 'null' })).toBe('nekko-agent-pair:');
  });

  it('keeps a web UI origin the phone can reach', () => {
    expect(pairingBase(at('http://studio.tail1234.ts.net:4317/'))).toBe('http://studio.tail1234.ts.net:4317/');
    expect(pairingBase(at('https://agent.example.com/'))).toBe('https://agent.example.com/');
  });
});
