import { describe, expect, it } from 'vitest';
import { PhoneAccessError, redactPhoneResult, screenPhoneCall } from './phone-access.js';
import { PHONE_FILES_VIEW, phoneFilesSecret } from './phone-files.js';

/** IO-33 FA-1 and FA-5: files and logs from a phone (phone-files.ts). */

const CHAT = { sessionId: 's1' };
const HASH = 'f'.repeat(64);

const refusal = (channel: string, args: unknown[]) => {
  try {
    screenPhoneCall(channel, args);
  } catch (e) {
    expect(e).toBeInstanceOf(PhoneAccessError);
    return (e as PhoneAccessError).message;
  }
  return 'ok';
};

describe('files from a phone', () => {
  it('names a folder by id only and rebuilds the arguments', () => {
    expect(screenPhoneCall('files:list', [CHAT]).callArgs).toEqual([CHAT, '']);
    expect(refusal('files:list', [{ path: '/' }])).toBe('Not allowed from a paired phone (option-denied): path');
    expect(screenPhoneCall('files:read', [CHAT, 'a.ts']).callArgs).toEqual([CHAT, 'a.ts', { maxBytes: PHONE_FILES_VIEW.readBytes }]);
  });

  it('refuses secret files before the computer is asked', () => {
    for (const p of ['.env', 'a/.env.production', '.ssh/config', 'certs/server.key', '.git/config', 'x/.git-credentials', 'C:\\u\\.aws\\credentials']) {
      expect(phoneFilesSecret(p), p).toBe(true);
    }
    for (const p of ['src/env.ts', '.github/workflows/ci.yml', 'gitconfig.md', '.git/HEAD']) expect(phoneFilesSecret(p), p).toBe(false);
    expect(refusal('files:read', [CHAT, '.env'])).toBe('Not allowed from a paired phone (value-invalid): secret file');
  });

  it('saves only over the version the phone read, and only what it could read whole', () => {
    expect(refusal('files:write', [CHAT, 'a.md', 'x'])).toBe('Not allowed from a paired phone (value-invalid): expectHash');
    const fits = 'é'.repeat(PHONE_FILES_VIEW.writeBytes / 2);
    expect(screenPhoneCall('files:write', [CHAT, 'a.md', fits, { expectHash: HASH }]).callArgs?.[2]).toBe(fits);
    expect(refusal('files:write', [CHAT, 'a.md', `${fits}a`, { expectHash: HASH }])).toBe(
      'Not allowed from a paired phone (value-invalid): content too large',
    );
  });

  it('caps what a read returns and drops anything unexpected', () => {
    const content = `${'x'.repeat(PHONE_FILES_VIEW.readBytes - 1)}😀tail`;
    const view = redactPhoneResult('files:read', { path: 'a.txt', name: 'a.txt', kind: 'text', content, truncated: false, editable: true, abs: '/x' }) as Record<string, unknown>;
    expect((view.content as string).length).toBe(PHONE_FILES_VIEW.readBytes - 1);
    expect(view).toMatchObject({ truncated: true, editable: false });
    expect(view).not.toHaveProperty('abs');
    expect(redactPhoneResult('files:read', { path: 'deploy/id_rsa', kind: 'text', content: 'KEY' })).toBeNull();
  });

  it('keeps the end of a long log tail', () => {
    const text = `😀${'y'.repeat(PHONE_FILES_VIEW.logTextChars - 1)}`;
    const view = redactPhoneResult('logs:read', { id: 'daemon', text, truncated: false }) as Record<string, unknown>;
    expect(view.text).toBe('y'.repeat(PHONE_FILES_VIEW.logTextChars - 1));
    expect(view.truncated).toBe(true);
  });

  it('still refuses the desktop absolute-path calls', () => {
    for (const c of ['file:read', 'file:write', 'dir:list', 'attachment:import']) {
      expect(refusal(c, ['/etc/passwd'])).toBe(`Not allowed from a paired phone (channel-denied): ${c}`);
    }
  });
});
