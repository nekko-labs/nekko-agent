import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { syncAppActivity } from './appActivity.js';

function fakeDom(initial: { visible: boolean; focused: boolean }) {
  const state = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  const on = (t: string, f: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); };
  const off = (t: string, f: () => void) => { listeners.get(t)?.delete(f); };
  const fire = (t: string) => { for (const f of listeners.get(t) ?? []) f(); };
  const root = { dataset: {} as Record<string, string> };
  const doc = {
    documentElement: root,
    get visibilityState() { return state.visible ? 'visible' : 'hidden'; },
    hasFocus: () => state.focused,
    addEventListener: on,
    removeEventListener: off,
  } as unknown as Document;
  const win = { addEventListener: on, removeEventListener: off } as unknown as Window;
  return { state, root, doc, win, fire, listeners };
}

describe('syncAppActivity', () => {
  it('marks the document inactive on blur and hide, active again on focus', () => {
    const d = fakeDom({ visible: true, focused: true });
    const stop = syncAppActivity(d.doc, d.win);
    expect('appInactive' in d.root.dataset).toBe(false);
    d.state.focused = false; d.fire('blur');
    expect('appInactive' in d.root.dataset).toBe(true);
    d.state.focused = true; d.fire('focus');
    expect('appInactive' in d.root.dataset).toBe(false);
    d.state.visible = false; d.fire('visibilitychange');
    expect('appInactive' in d.root.dataset).toBe(true);
    stop();
    expect('appInactive' in d.root.dataset).toBe(false);
    expect([...d.listeners.values()].every((s) => s.size === 0)).toBe(true);
  });

  it('starts inactive when the window opens without focus', () => {
    const d = fakeDom({ visible: true, focused: false });
    syncAppActivity(d.doc, d.win);
    expect('appInactive' in d.root.dataset).toBe(true);
  });
});

describe('looping decorations stay cheap to composite', () => {
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
  it('pauses every animation while the app is inactive', () => {
    expect(css).toContain('html[data-app-inactive] *, html[data-app-inactive] *::before, html[data-app-inactive] *::after { animation-play-state: paused !important; }');
  });
  it('removes working beams and bounds empty-agent motion to a translated texture', () => {
    expect(css).not.toContain('composer-beam');
    expect(css).toContain('animation: empty-agent-wave 22.5s steps(36, end) infinite alternate paused;');
    expect(css).toContain('.pixel-wave-background[data-wave-paused] .pixel-wave-texture { animation-play-state: paused; }');
    expect(css).toContain('.pixel-wave-texture { animation: none; }');
    expect(css).toContain('animation: wall-needs-you-pulse 2.4s steps(12, end) infinite;');
    expect(css).not.toMatch(/\.status-rocket[^{]*\{[^}]*(ease-in-out|linear) infinite/);
  });
});
