import { describe, expect, it } from 'vitest';
import { SIMPLE_ITEMS, parseSimpleChoices, simpleAreas, simpleShown, simpleVisibility } from './simple-mode.js';

describe('simple mode catalogue', () => {
  it('has unique ids', () => {
    expect(new Set(SIMPLE_ITEMS.map((i) => i.id)).size).toBe(SIMPLE_ITEMS.length);
  });

  it('shows only the model and suggestions in Simple by default', () => {
    const shown = SIMPLE_ITEMS.filter((i) => simpleShown(i.id, false)).map((i) => i.id);
    expect(shown).toEqual(['model', 'suggest']);
    expect(SIMPLE_ITEMS.every((i) => simpleShown(i.id, true))).toBe(true);
  });

  it('applies the three choices in each mode', () => {
    expect(simpleShown('effort', false, { effort: 'show' })).toBe(true);
    expect(simpleShown('model', false, { model: 'expert' })).toBe(false);
    expect(simpleShown('model', true, { model: 'expert' })).toBe(true);
    expect(simpleShown('effort', true, { effort: 'hide' })).toBe(false);
  });

  it('shows ids it does not know', () => {
    expect(simpleVisibility('nope', { nope: 'hide' })).toBe('show');
    expect(simpleShown('nope', false)).toBe(true);
  });

  it('parses saved choices defensively', () => {
    expect(parseSimpleChoices('{"effort":"show","model":"show","bad":"hide","stats":"maybe"}')).toEqual({ effort: 'show' });
    expect(parseSimpleChoices('not json')).toEqual({});
    expect(parseSimpleChoices(null)).toEqual({});
    expect(parseSimpleChoices([])).toEqual({});
    expect(parseSimpleChoices({ context: 'hide' })).toEqual({ context: 'hide' });
  });

  it('groups each platform by area without the other platform', () => {
    const phone = simpleAreas('phone');
    expect(phone.flatMap((a) => a.items).some((i) => i.id === 'logs')).toBe(false);
    expect(phone.flatMap((a) => a.items).some((i) => i.id === 'ph-monitors')).toBe(true);
    expect(simpleAreas('desktop')[0]).toMatchObject({ area: 'Chat · header' });
  });
});
