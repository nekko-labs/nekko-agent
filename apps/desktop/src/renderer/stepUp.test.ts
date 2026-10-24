import { afterEach, describe, expect, it, vi } from 'vitest';
import { askStepUp, askStepUpProof, installStepUpHandler, resetStepUp, settleStepUp, useStepUp } from './stepUp.js';
import { NEEDS_HTTPS_MESSAGE, pageRpId, platformPasskeyAvailable, webAuthnUnavailableReason } from './secureContext.js';

afterEach(resetStepUp);

describe('the step-up sheet’s queue', () => {
  it('shows one ask at a time and resolves each with its answer', async () => {
    const a = askStepUp('pairing', 'm');
    const b = askStepUpProof('Turn off step-up', 'k1');
    const first = useStepUp.getState().current!;
    expect(first).toMatchObject({ mode: 'cover', action: 'pairing' });
    settleStepUp(first.id, true);
    expect(await a).toBe(true);
    const second = useStepUp.getState().current!;
    expect(second).toMatchObject({ mode: 'proof', not: 'k1' });
    settleStepUp(second.id, { recovery: 'abcde-fghij' });
    expect(await b).toEqual({ recovery: 'abcde-fghij' });
    expect(useStepUp.getState().current).toBeNull();
  });

  it('answers calls for the same action class with one confirmation (Lock phones)', async () => {
    const a = askStepUp('phoneAccess', 'm');
    const b = askStepUp('phoneAccess', 'm');
    expect(useStepUp.getState().queue).toHaveLength(0);
    settleStepUp(useStepUp.getState().current!.id, true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });

  it('hands the transport the sheet and takes it back', () => {
    const api = { setStepUpHandler: vi.fn() };
    const off = installStepUpHandler(api);
    expect(typeof api.setStepUpHandler.mock.calls[0][0]).toBe('function');
    off();
    expect(api.setStepUpHandler).toHaveBeenLastCalledWith(null);
  });
});

describe('where keys can work', () => {
  const browser = (o: Record<string, unknown>) => ({ PublicKeyCredential: {}, navigator: { credentials: {} }, location: { hostname: 'localhost', protocol: 'http:' }, ...o });
  it('works in the desktop app and in a secure browser page', () => {
    expect(webAuthnUnavailableReason({ nekkoChrome: {} })).toBeNull();
    expect(webAuthnUnavailableReason(browser({ isSecureContext: true }))).toBeNull();
  });

  it('says step-up needs https on a plain-http Local Web UI off this computer', () => {
    expect(webAuthnUnavailableReason(browser({ isSecureContext: false, location: { hostname: 'box.lan', protocol: 'http:' } }))).toBe(NEEDS_HTTPS_MESSAGE);
    expect(webAuthnUnavailableReason({ isSecureContext: true })).toContain('This browser');
  });

  it('binds keys to localhost on the desktop and to the page’s host in a browser', () => {
    expect(pageRpId({ nekkoChrome: {}, location: { hostname: 'x', protocol: 'file:' } })).toBe('localhost');
    expect(pageRpId({ location: { hostname: 'Agent.Example.com', protocol: 'https:' } })).toBe('agent.example.com');
    expect(platformPasskeyAvailable('linux')).toBe(false);
    expect(platformPasskeyAvailable('darwin')).toBe(true);
  });
});
