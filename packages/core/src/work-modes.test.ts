import { describe, it, expect } from 'vitest';
import { MARKET_SKILLS, SKILLS, WORK_MODES, getWorkMode, workModePrompt, workModePrompts } from '@nekko-agent/shared';

describe('work modes', () => {
  it('has unique ids and labels, with the default first', () => {
    expect(WORK_MODES[0].id).toBe('default');
    expect(new Set(WORK_MODES.map((m) => m.id)).size).toBe(WORK_MODES.length);
    expect(new Set(WORK_MODES.map((m) => m.label)).size).toBe(WORK_MODES.length);
  });

  it('only names skills that exist, so a mode never brings an empty skill', () => {
    const known = new Set([...SKILLS.map((s) => s.name), ...MARKET_SKILLS.map((s) => s.name)]);
    for (const m of WORK_MODES) for (const s of m.skills) expect(known.has(s), `${m.id} -> ${s}`).toBe(true);
  });

  it('adds nothing for the default, an absent or an unknown mode', () => {
    expect(workModePrompt('default')).toBe('');
    expect(workModePrompt(undefined)).toBe('');
    expect(workModePrompt('nope')).toBe('');
    expect(getWorkMode('nope').id).toBe('default');
  });

  it('brings the mode instructions and its skills, and says permissions are unchanged', () => {
    const text = workModePrompt('better-review');
    expect(text).toContain('Work mode: Better review');
    expect(text).toContain('does not change permissions, tools or guardrails');
    expect(text).toContain('cites the exact file and line');
    expect(text).toContain('- security-review: ');
    expect(text).toContain('- review-council: ');
  });

  it('never mentions loosening permissions', () => {
    for (const m of WORK_MODES) expect(workModePrompt(m.id).toLowerCase()).not.toMatch(/yolo|skip (the )?approval|disable guardrail/);
  });

  it('exports every mode for the daemon catalog', () => {
    expect(Object.keys(workModePrompts())).toEqual(WORK_MODES.map((m) => m.id));
  });
});
