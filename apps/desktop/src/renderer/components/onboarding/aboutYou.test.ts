import { describe, expect, it } from 'vitest';
import { parseSimpleChoices, simpleShown } from '@nekko-agent/shared';
import { MINIMAL_HIDES, PROFILES, currentLevel, levelForProfile, monitorsDefault, validEmail } from './aboutYou.js';
import { ONBOARDING_STEPS, SKIPPABLE_STEP_IDS, WIDE_STEP_IDS } from './onboardingMachine.js';

describe('setup about-you answers', () => {
  it('seeds Detailed and monitors only for developers, Minimal for explorers', () => {
    expect(levelForProfile('developer')).toBe('detailed');
    expect(levelForProfile('exploring')).toBe('minimal');
    expect(levelForProfile('designer')).toBe('regular');
    expect(levelForProfile(undefined)).toBe('regular');
    expect(PROFILES.filter((p) => monitorsDefault(p.level)).map((p) => p.id)).toEqual(['developer']);
  });

  it('Minimal hides real Simple mode controls, and reads back as Minimal', () => {
    const choices = parseSimpleChoices(Object.fromEntries(MINIMAL_HIDES.map((id) => [id, 'hide'])));
    for (const id of MINIMAL_HIDES) expect(simpleShown(id, false, choices, { changes: true })).toBe(false);
    expect(currentLevel(false, choices as Record<string, string>)).toBe('minimal');
    expect(currentLevel(false, {})).toBe('regular');
    expect(currentLevel(true, {})).toBe('detailed');
  });

  it('accepts what Nekko Cloud accepts', () => {
    for (const ok of ['a@b.co', ' ada@example.com ']) expect(validEmail(ok)).toBe(true);
    for (const bad of ['', 'a@b', '@b.co', 'a b@c.co', `${'a'.repeat(320)}@b.co`]) expect(validEmail(bad)).toBe(false);
  });

  it('asks about you before the look, and every new step can be skipped', () => {
    expect(ONBOARDING_STEPS.map((s) => s.id).slice(0, 6)).toEqual(['welcome', 'name', 'email', 'work', 'detail', 'theme']);
    for (const id of ['name', 'email', 'work', 'detail']) expect(SKIPPABLE_STEP_IDS.has(id)).toBe(true);
    for (const id of WIDE_STEP_IDS) expect(ONBOARDING_STEPS.some((s) => s.id === id)).toBe(true);
  });
});
