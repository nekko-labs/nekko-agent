import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createNativeNotificationPoster, windowsToastXml } from './nativeNotifications.js';

class Native extends EventEmitter {
  show = vi.fn();
  close = vi.fn(() => { this.emit('close'); });
}
const notice = { sessionId: 'a/b', kind: 'finished' as const, title: 'Finished', body: 'Chat' };
describe('injected native notification adapter', () => {
  it('sets native options, delivers clicks once, bounds retention and ignores disposed clicks', () => {
    const instances: Native[] = [];
    const create = vi.fn(() => { const n = new Native(); instances.push(n); return n; });
    const link = vi.fn();
    const poster = createNativeNotificationPoster({ isSupported: () => true, create }, link, 'icon.png');
    poster.post(notice);
    expect(create).toHaveBeenCalledWith({ title: 'Finished', body: 'Chat', silent: true, icon: 'icon.png' });
    expect(instances[0].show).toHaveBeenCalledOnce();
    instances[0].emit('click'); instances[0].emit('click');
    expect(link).toHaveBeenCalledExactlyOnceWith('nekko-agent://session/open?id=a%2Fb');
    for (let i = 0; i < 9; i++) poster.post(notice);
    expect(instances[1].close).toHaveBeenCalledOnce();
    poster.dispose();
    instances.at(-1)!.emit('click');
    poster.post(notice);
    expect(create).toHaveBeenCalledTimes(10);
    expect(link).toHaveBeenCalledOnce();
    expect(instances.at(-1)!.close).toHaveBeenCalled();
  });
  it('does not create notices on unsupported platforms', () => {
    const create = vi.fn();
    createNativeNotificationPoster({ isSupported: () => false, create }, vi.fn()).post(notice);
    expect(create).not.toHaveBeenCalled();
  });
  it('gives a Windows toast its link and leaves other platforms on the plain notice', () => {
    const create = vi.fn(() => new Native());
    createNativeNotificationPoster({ isSupported: () => true, create, windowsToast: { icon: 'C:\\icon.png' } }, vi.fn()).post(notice);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      toastXml: '<toast launch="nekko-agent://session/open?id=a%2Fb"><visual><binding template="ToastGeneric"><text>Finished</text><text>Chat</text><image id="1" placement="appLogoOverride" hint-crop="none" src="C:\\icon.png"/></binding></visual><audio silent="true"/></toast>',
    }));
  });
  it('escapes chat titles and drops characters XML cannot hold', () => {
    const xml = windowsToastXml({ title: 'A & B', body: '<x>"\u0007', silent: false, link: 'nekko-agent://workflow/run?a=1&b=2' });
    expect(xml).toBe('<toast launch="nekko-agent://workflow/run?a=1&amp;b=2"><visual><binding template="ToastGeneric"><text>A &amp; B</text><text>&lt;x&gt;&quot;</text></binding></visual></toast>');
  });
  it('opens the chat from an activation after the toast has left the screen', () => {
    const link = vi.fn();
    const native = new Native();
    const poster = createNativeNotificationPoster({ isSupported: () => true, create: () => native, windowsToast: {} }, link);
    poster.post(notice);
    native.emit('close');
    poster.activated('nekko-agent://session/open?id=a%2Fb');
    expect(link).toHaveBeenCalledExactlyOnceWith('nekko-agent://session/open?id=a%2Fb');
  });
  it('counts a click reported both ways once, and a later click again', () => {
    vi.useFakeTimers();
    try {
      const link = vi.fn();
      const native = new Native();
      const poster = createNativeNotificationPoster({ isSupported: () => true, create: () => native, windowsToast: {} }, link);
      poster.post(notice);
      native.emit('click');
      poster.activated('nekko-agent://session/open?id=a%2Fb');
      expect(link).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(2000);
      poster.activated('nekko-agent://session/open?id=a%2Fb');
      expect(link).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('ignores activations that are not app links, and any after disposal', () => {
    const link = vi.fn();
    const poster = createNativeNotificationPoster({ isSupported: () => true, create: () => new Native() }, link);
    poster.activated('');
    poster.activated('https://example.com');
    poster.dispose();
    poster.activated('nekko-agent://settings');
    expect(link).not.toHaveBeenCalled();
  });
});
