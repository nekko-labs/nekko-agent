import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createNativeNotificationPoster } from './nativeNotifications.js';

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
});
