import { describe, expect, it } from 'vitest';
import { artifactAccess, chatLinks, localPath, loopbackOrigins } from './chat-links.js';
import { callFromPhone, phoneChannelClass, PhoneAccessError, redactPhoneResult, screenPhoneCall } from './phone-access.js';
import { PHONE_ARTIFACTS_VIEW } from './phone-artifacts.js';

/** #1095: what the agent linked in a chat, opened on a phone (chat-links.ts, phone-artifacts.ts). */

const refusal = (channel: string, args: unknown[]) => {
  try {
    screenPhoneCall(channel, args);
  } catch (e) {
    expect(e).toBeInstanceOf(PhoneAccessError);
    return (e as PhoneAccessError).message;
  }
  return 'ok';
};

describe('chat links', () => {
  it('reads only the assistant messages, outside code', () => {
    const messages = [
      { role: 'user', content: '[x](/tmp/user.md) http://localhost:1' },
      { role: 'assistant', content: 'Wrote [the plan](plan.md) and ![shot](file:///C:/out/shot%201.png); serving on `http://127.0.0.1:5173`.\n```\n[no](/tmp/no.md) http://localhost:2\n```' },
    ];
    expect(chatLinks(messages, 'C:/proj')).toEqual({ artifacts: ['C:/proj/plan.md', 'C:/out/shot 1.png'], origins: ['http://localhost:5173'] });
    expect(chatLinks(messages).artifacts).toEqual(['C:/out/shot 1.png']);
  });

  it('treats localhost, 127.0.0.1 and 0.0.0.0 as one origin, [::1] as another', () => {
    expect(loopbackOrigins('http://localhost:3000 http://127.0.0.1:3000 http://0.0.0.0:3000/x http://[::1]:3000')).toEqual([
      'http://localhost:3000',
      'http://[::1]:3000',
    ]);
    expect(loopbackOrigins('http://localhost.evil.com:3000 http://localhost@evil.com')).toEqual([]);
  });

  it('opens a linked page and the assets in its folder, nothing else', () => {
    const links = { artifacts: ['/w/site/index.html'], origins: [] };
    expect(artifactAccess('/w/site/index.html', links, false)).toEqual({ kind: 'linked', root: '/w/site/index.html' });
    expect(artifactAccess('/w/site/css/app.css', links, false)).toEqual({ kind: 'asset', root: '/w/site' });
    expect(artifactAccess('/w/site/.git/x.json', links, false)).toBeNull();
    expect(artifactAccess('/w/site/tool.exe', links, false)).toBeNull();
    expect(artifactAccess('/w/other.css', links, false)).toBeNull();
    expect(localPath('/w/site/../../etc/x.css')).toBe('/etc/x.css');
  });
});

describe('artifact and preview calls from a phone', () => {
  it('are read class', () => {
    expect(phoneChannelClass('artifact:read')).toBe('read');
    expect(phoneChannelClass('preview:fetch')).toBe('read');
  });

  it('rebuild the arguments from the checked fields', () => {
    expect(screenPhoneCall('artifact:read', ['s1', 'file:///C:/a/b%20c.md']).callArgs).toEqual(['s1', 'C:/a/b c.md']);
    expect(screenPhoneCall('preview:fetch', ['s1', 'HTTP://LOCALHOST:5173/a#x']).callArgs).toEqual(['s1', 'http://localhost:5173/a', { method: 'GET' }]);
    expect(refusal('preview:fetch', ['s1', 'http://localhost:5173/', { headers: {} }])).toBe('Not allowed from a paired phone (option-denied): headers');
    expect(refusal('preview:fetch', ['s1', 'http://localhost:5173/', { method: 'DELETE' }])).toBe('Not allowed from a paired phone (value-invalid): method');
    expect(refusal('preview:fetch', ['s1', 'http://192.168.1.2:5173/'])).toBe('Not allowed from a paired phone (value-invalid): url');
    expect(refusal('artifact:read', ['s1', 'notes/a.md'])).toBe('Not allowed from a paired phone (value-invalid): path');
    expect(refusal('artifact:read', ['s1', '/home/me/.aws/credentials'])).toBe('Not allowed from a paired phone (value-invalid): secret file');
  });

  it('caps what comes back and drops what it should not carry', () => {
    const content = `${'x'.repeat(PHONE_ARTIFACTS_VIEW.textBytes - 1)}😀`;
    const view = redactPhoneResult('artifact:read', { path: '/a.txt', kind: 'text', content, truncated: false, abs: '/real' }) as Record<string, unknown>;
    expect((view.content as string).length).toBe(PHONE_ARTIFACTS_VIEW.textBytes - 1);
    expect(view.truncated).toBe(true);
    expect(view).not.toHaveProperty('abs');
    const preview = redactPhoneResult('preview:fetch', { url: 'http://localhost:1/', status: 200, headers: { 'set-cookie': 'a', etag: 'e' }, base64: '' }) as Record<string, unknown>;
    expect(preview.headers).toEqual({ etag: 'e' });
  });

  it('runs through callFromPhone with the checked arguments only', async () => {
    const seen: Array<[string, unknown[]]> = [];
    const out = await callFromPhone((channel, args) => {
      seen.push([channel, args]);
      return { url: 'http://localhost:5173/', status: 200, contentType: 'text/html', headers: {}, base64: 'QQ==', truncated: false, extra: 1 };
    }, 'preview:fetch', ['s1', 'http://0.0.0.0:5173/', { method: 'HEAD' }]);
    expect(seen).toEqual([['preview:fetch', ['s1', 'http://0.0.0.0:5173/', { method: 'HEAD' }]]]);
    expect(out).toEqual({ url: 'http://localhost:5173/', status: 200, contentType: 'text/html', headers: {}, base64: 'QQ==', truncated: false });
  });
});
