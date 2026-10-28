import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { useStore } from '../store.js';

// The dialog's Modal is captured so a test can press its buttons and fire its own close (Escape, backdrop).
const modal = vi.hoisted(() => ({ props: null as null | Record<string, any> }));
vi.mock('./primitives/Modal.js', () => ({ Modal: (props: Record<string, any>) => { modal.props = props; return <div>{props.children}</div>; } }));
vi.mock('@remotion/player', () => ({ Player: () => null }));
const { VoiceIntro, VOICE_INTRO_SCENES, VOICE_INTRO_FPS, PRIVACY_PROMISE } = await import('./VoiceIntro.js');

const PROMISE = 'Speech is turned into text on your own computer or phone. We never store, hear, or train on your voice, and your chats stay yours.';

function buttons(): Array<React.ReactElement<Record<string, any>>> {
  const found: Array<React.ReactElement<Record<string, any>>> = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    if (child.type === 'button') found.push(child);
    walk(child.props.children);
  });
  walk(modal.props!.children);
  return found;
}
const press = (name: string) => buttons().find(b => b.props['aria-label'] === name || b.props.children === name)!.props.onClick();

let updateSettings: ReturnType<typeof vi.fn>;
beforeEach(() => {
  modal.props = null;
  useStore.setState({ settings: { voice: { enabled: true, engine: 'whisper' } } as never });
  updateSettings = vi.fn(async (patch: Record<string, unknown>) => patch);
  window.nekko = { updateSettings } as never;
});

function open(withTurnOn = true) {
  const onClose = vi.fn();
  const onTurnOn = vi.fn();
  renderToStaticMarkup(<VoiceIntro onClose={onClose} onTurnOn={withTurnOn ? onTurnOn : undefined} />);
  return { onClose, onTurnOn };
}

describe('voice intro dialog', () => {
  it.each([
    ['the close button', () => press('Close')],
    ['Not now', () => press('Not now')],
    ['Escape or the backdrop', () => modal.props!.onClose()],
  ])('closing with %s remembers it was seen and does not start listening', async (_, close) => {
    const { onClose, onTurnOn } = open();
    close();
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ voice: { enabled: true, engine: 'whisper', introSeen: true } }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onTurnOn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(useStore.getState().settings?.voice?.introSeen).toBe(true));
  });

  it('keeps Escape and the backdrop closing it', () => {
    open();
    expect(modal.props!.closeOnEscape).not.toBe(false);
    expect(modal.props!.closeOnScrimClick).not.toBe(false);
  });

  it('Turn on remembers it was seen, closes, then starts listening', async () => {
    const { onClose, onTurnOn } = open();
    press('Turn on');
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ voice: expect.objectContaining({ introSeen: true }) }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onTurnOn).toHaveBeenCalledOnce();
  });

  it('replayed from settings it offers Done, not Turn on', () => {
    open(false);
    const labels = buttons().map(b => b.props['aria-label'] ?? b.props.children);
    expect(labels).toContain('Done');
    expect(labels).not.toContain('Turn on');
  });
});

describe('voice intro video', () => {
  it('ends on the privacy promise, word for word', () => {
    expect(PRIVACY_PROMISE).toBe(PROMISE);
    expect(VOICE_INTRO_SCENES.at(-1)!.caption).toBe(PROMISE);
  });

  it('runs 30 to 45 seconds at 30 fps', () => {
    const seconds = VOICE_INTRO_SCENES.reduce((sum, s) => sum + s.seconds, 0);
    expect(VOICE_INTRO_FPS).toBe(30);
    expect(seconds).toBeGreaterThanOrEqual(30);
    expect(seconds).toBeLessThanOrEqual(45);
  });

  it('says the Lock Screen mic asks for Face ID first, in the iPhone scene, and uses no em dash', () => {
    const text = VOICE_INTRO_SCENES.map(s => `${s.caption} ${s.sub ?? ''}`).join(' ');
    const phone = VOICE_INTRO_SCENES.find(s => s.caption.startsWith('On iPhone'))!;
    expect(phone.sub).toMatch(/lock screen.*face id.*chat/i);
    expect(text).not.toContain('\u2014');
  });
});
