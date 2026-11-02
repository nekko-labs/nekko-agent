import { describe, expect, it } from 'vitest';
import { parseCustomizations, parseLayoutDoc, resolveSlots, type LayoutDoc } from './ui-layout.js';

const EXPERT: LayoutDoc = {
  id: 'nekko.expert',
  name: 'Expert',
  slots: { rail: ['view.agents', 'view.models'], 'titlebar.end': ['control.mode-switch'], 'chat.composer': ['control.chat.effort', 'control.chat.model'] },
  visibility: {},
  theme: null,
};
const anywhere = () => true;

describe('resolveSlots', () => {
  it('passes the official contents through', () => {
    expect(resolveSlots(EXPERT, { allowed: anywhere })).toEqual(EXPERT.slots);
  });

  it('adds mod defaults, then applies placements over them', () => {
    const out = resolveSlots(EXPERT, {
      allowed: anywhere,
      modDefaults: { 'mod.gpu.panel': 'rail', 'mod.gpu.dial': 'titlebar.end' },
      placements: { 'mod.gpu.dial': 'rail', 'control.chat.effort': 'titlebar.end' },
    });
    expect(out.rail).toEqual(['view.agents', 'view.models', 'mod.gpu.panel', 'mod.gpu.dial']);
    expect(out['titlebar.end']).toEqual(['control.mode-switch', 'control.chat.effort']);
    expect(out['chat.composer']).toEqual(['control.chat.model']);
  });

  it('honours placements pinned to this layout only', () => {
    const placements = { 'view.models': { slot: 'titlebar.end', layout: 'nekko.simple' } };
    expect(resolveSlots(EXPERT, { allowed: anywhere, placements }).rail).toContain('view.models');
    const pinned = { 'view.models': { slot: 'titlebar.end', layout: 'nekko.expert' } };
    expect(resolveSlots(EXPERT, { allowed: anywhere, placements: pinned })['titlebar.end']).toContain('view.models');
  });

  it('ignores refused, missing and unknown placements and leaves its inputs alone', () => {
    const placements = { 'view.agents': 'chat.composer', 'view.models': 'no.such.slot', 'gone.surface': 'rail' };
    const before = JSON.stringify({ EXPERT, placements });
    const out = resolveSlots(EXPERT, { allowed: (s, slot) => !(s === 'view.agents' && slot === 'chat.composer'), placements });
    expect(out).toEqual(EXPERT.slots);
    expect(JSON.stringify({ EXPERT, placements })).toBe(before);
  });

  it('treats prototype names as ordinary slots', () => {
    const out = resolveSlots(EXPERT, { allowed: anywhere, placements: { 'view.agents': 'constructor', 'view.models': '__proto__' } });
    expect(out).toEqual(EXPERT.slots);
    const odd = parseLayoutDoc('{"id":"x.y","name":"X","slots":{"__proto__":["a"]}}')!;
    expect(Object.getPrototypeOf(resolveSlots(odd, { allowed: anywhere }))).toBe(Object.prototype);
  });

  it('never shows a surface twice', () => {
    const doubled = { ...EXPERT, slots: { ...EXPERT.slots, 'titlebar.end': ['view.agents'] } };
    const out = resolveSlots(doubled, { allowed: anywhere, modDefaults: { 'view.agents': 'rail' } });
    expect(Object.values(out).flat().filter((s) => s === 'view.agents')).toHaveLength(1);
  });
});

describe('parseLayoutDoc', () => {
  it('keeps valid fields and refuses junk', () => {
    expect(parseLayoutDoc(EXPERT)).toEqual(EXPERT);
    expect(parseLayoutDoc({ ...EXPERT, visibility: { a: 'show', b: 'loud' } })?.visibility).toEqual({ a: 'show' });
    expect(parseLayoutDoc({ name: 'x' })).toBeNull();
    expect(parseLayoutDoc('{')).toBeNull();
  });
});

describe('parseCustomizations', () => {
  it('fills every default from nothing', () => {
    const c = parseCustomizations({});
    expect(c.layout).toBe('nekko.simple');
    expect(c.theme.textScale).toBe(1);
    expect(c.placements).toEqual({});
    expect(parseCustomizations('not json')).toEqual(c);
  });

  it('falls back field by field', () => {
    for (const textScale of ['big', Number.NaN, 10]) expect(parseCustomizations({ theme: { textScale } }).theme.textScale).toBe(1);
    expect(parseCustomizations({ theme: { textScale: 1.25 } }).theme.textScale).toBe(1.25);
    expect(parseCustomizations({ visibility: { a: 'expert', b: 7 } }).visibility).toEqual({ a: 'expert' });
    expect(parseCustomizations({ deviceOnly: ['theme', 'secrets'] }).deviceOnly).toEqual(['theme']);
    expect(parseCustomizations({ mods: { 'com.x.y': { enabled: true }, bad: 1 } }).mods).toEqual({ 'com.x.y': { enabled: true } });
    expect(parseCustomizations({ placements: { a: 'rail', b: { slot: 'main', layout: 'nekko.expert' }, c: 5 } }).placements)
      .toEqual({ a: 'rail', b: { slot: 'main', layout: 'nekko.expert' } });
  });
});
