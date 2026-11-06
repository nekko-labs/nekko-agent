import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./primitives/Modal.js', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

import { DeleteEverythingDialog, WIPE_ITEMS, wipeEverything } from './DeleteEverythingDialog.js';

afterEach(() => vi.unstubAllGlobals());
const esc = (s: string) => renderToStaticMarkup(<>{s}</>);

describe('Delete everything', () => {
  it('says exactly what goes and what stays, with models left alone by default', () => {
    const html = renderToStaticMarkup(<DeleteEverythingDialog busy={false} onCancel={() => {}} onConfirm={() => {}} />);
    for (const item of WIPE_ITEMS) expect(html).toContain(esc(item));
    for (const s of ['Sign-ins', 'Keychain', 'Credential Manager', 'Logs', 'CI runners', 'Also delete downloaded models']) expect(html).toContain(s);
    expect(html).toMatch(/<input[^>]*data-wipe-models="true"[^>]*>/);
    expect(html).not.toMatch(/data-wipe-models="true"[^>]*checked/);
  });

  it('sends the models choice and forgets the window storage', async () => {
    const wipeAllData = vi.fn().mockResolvedValue({ theme: 'system' });
    vi.stubGlobal('window', { nekko: { wipeAllData } });
    const local = { clear: vi.fn() };
    const broken = { clear: vi.fn(() => { throw new Error('denied'); }) };
    await expect(wipeEverything(true, [local, broken])).resolves.toEqual({ theme: 'system' });
    expect(wipeAllData).toHaveBeenCalledExactlyOnceWith({ models: true });
    expect(local.clear).toHaveBeenCalledOnce();
    await wipeEverything(false, []);
    expect(wipeAllData).toHaveBeenLastCalledWith({ models: false });
  });

  it('keeps the window storage when the engine refuses', async () => {
    vi.stubGlobal('window', { nekko: { wipeAllData: vi.fn().mockRejectedValue(new Error('busy')) } });
    const local = { clear: vi.fn() };
    await expect(wipeEverything(false, [local])).rejects.toThrow('busy');
    expect(local.clear).not.toHaveBeenCalled();
  });
});
