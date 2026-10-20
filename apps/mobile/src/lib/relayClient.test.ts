import { describe, expect, it } from 'vitest';
import { deriveKeyBytes, open, seal } from './e2e';
import { RelayClient, type WelcomedDevice } from './relayClient';

const SECRET = '0123456789abcdef0123456789abcdef';
const ROOM = 'a1b2c3d4e5f60718';

/** One relay socket with a scripted computer behind it. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe('relay client against a newer computer and relay', () => {
  it('ignores the welcome protocol field and the relay push frames (IO-30, IO-32)', async () => {
    const keyBytes = await deriveKeyBytes(SECRET, ROOM);
    const welcomes: WelcomedDevice[] = [];
    const states: string[] = [];
    const client = new RelayClient({
      relayUrl: 'wss://relay.test',
      room: ROOM,
      key: SECRET,
      keyBytes,
      deviceId: 'dev-1',
      deviceName: 'Pixel',
      platform: 'android',
      WebSocketImpl: FakeSocket as never,
      onWelcome: (d) => welcomes.push(d),
      onState: (s) => states.push(s),
    });
    client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const ws = FakeSocket.last!;
    const hello = open(keyBytes, JSON.parse(ws.sent[0]).enc) as { type: string };
    expect(hello.type).toBe('hello');
    // A computer that speaks protocol 2 adds `protocol` to the welcome.
    const device = { id: 'dev-1', name: 'Pixel', platform: 'android' };
    ws.deliver({ enc: seal(keyBytes, { type: 'welcome', device, protocol: 2 }) });
    expect(client.current).toBe('online');
    expect(welcomes).toEqual([device]);
    // The relay's own frames for the iPhone: nothing changes here.
    ws.deliver({ type: 'push-registered', delivers: true });
    ws.deliver({ type: 'dismiss', tag: 'a'.repeat(32) });
    expect(client.current).toBe('online');
    expect(ws.sent.length).toBe(1);
    // Requests still flow.
    const call = client.call('app:info');
    await new Promise((r) => setTimeout(r, 5));
    const req = open(keyBytes, JSON.parse(ws.sent[1]).enc) as { id: number };
    ws.deliver({ enc: seal(keyBytes, { type: 'res', id: req.id, result: { version: '1' } }) });
    await expect(call).resolves.toEqual({ version: '1' });
    client.close();
    expect(states).toContain('online');
  });
});
