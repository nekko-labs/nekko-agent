import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import http2 from 'node:http2';
import { createPushSender } from './push.js';

afterEach(() => vi.restoreAllMocks());

describe('APNs attention transport', () => {
  it('uses alert priority for badge-only and badge-bearing dismissal, but background priority for unknown-count dismissal', async () => {
    const requests: { headers: http2.OutgoingHttpHeaders; body: any }[] = [];
    const hosts: string[] = [];
    const close = vi.fn();
    vi.spyOn(http2, 'connect').mockImplementation(((host: string) => {
      hosts.push(host);
      const client = new EventEmitter();
      return Object.assign(client, {
        close,
        request: (headers: http2.OutgoingHttpHeaders) => Object.assign(new EventEmitter(), {
          end(this: EventEmitter, body: string) {
            requests.push({ headers, body: JSON.parse(body) });
            this.emit('response', { ':status': 200 });
            this.emit('end');
          },
        }),
      });
    }) as unknown as typeof http2.connect);
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sender = createPushSender({ APNS_KEY_P8: key, APNS_KEY_ID: 'KEY', APNS_TEAM_ID: 'TEAM', APNS_BUNDLE_ID: 'dev.default', APNS_EXTRA_BUNDLE_IDS: 'dev.other', APNS_PRODUCTION: '1' });
    const token = 'a'.repeat(64);
    const tag = 'b'.repeat(32);
    await sender.sendBadge!(token, 0, 'dev.other');
    await sender.sendDismiss!(token, tag, undefined, 0);
    await sender.sendDismiss!(token, tag);
    await sender.send(token, 'ios', { title: 'Nekko Agent', body: 'Needs you', kind: 'needs-you', tag, badge: 3 }, 'unlisted');
    expect(requests.map((r) => [r.headers['apns-push-type'], r.headers['apns-priority'], r.headers['apns-topic']])).toEqual([
      ['alert', '10', 'dev.other'], ['alert', '10', 'dev.default'], ['background', '5', 'dev.default'], ['alert', '10', 'dev.default'],
    ]);
    expect(requests[0].body).toEqual({ aps: { badge: 0 } });
    expect(requests[1].body).toEqual({ aps: { 'content-available': 1, badge: 0 }, dismiss: tag });
    expect(requests[2].body).toEqual({ aps: { 'content-available': 1 }, dismiss: tag });
    expect(requests[3].body.aps.badge).toBe(3);
    expect(requests.every((r) => r.headers[':path'] === `/3/device/${token}`)).toBe(true);
    expect(hosts).toEqual(Array(4).fill('https://api.push.apple.com'));
    expect(close).toHaveBeenCalledTimes(4);
  });
});
