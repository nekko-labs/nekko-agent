import { describe, expect, it } from 'vitest';
import { draftSuggestions } from './promptAnalysis.js';

describe('draft suggestions', () => {
  const draft = 'Fix the layout shift in the settings panel.';
  it('offers practical additions without a persona, grade, or model recommendation', () => {
    const { suggestions, warnings } = draftSuggestions(draft);
    expect(suggestions.map(({ label }) => label)).toEqual(['Add context', 'Set boundaries', 'Ask for a check']);
    expect(warnings).toEqual([]);
    for (const { label, snippet } of suggestions) {
      expect(draftSuggestions(`${draft}\n\n${snippet}`).suggestions.map((item) => item.label)).not.toContain(label);
    }
  });
  it('skips advice already covered naturally in the draft', () => {
    expect(draftSuggestions('Use the attached screenshot to fix the layout. Don’t change the sidebar. Run the tests.').suggestions).toEqual([]);
  });
  it('warns about sensitive strings without echoing them', () => {
    expect(draftSuggestions('Token: sample12345 and user@example.test').warnings).toEqual([
      'Possible credential. Remove it before sending.',
      'This draft contains an email address. Share it only if needed.',
    ]);
  });
});
