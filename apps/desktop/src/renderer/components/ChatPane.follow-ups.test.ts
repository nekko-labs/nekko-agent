import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');

describe('one desktop follow-up surface', () => {
  it('removes the legacy typed-draft routing row, not just its empty-state visibility', () => {
    for (const legacy of ['data-work-place', 'Do it here', 'In a subagent', 'Here uses more context', 'offerSubagent', 'runFollowUp']) {
      expect(source).not.toContain(legacy);
    }
  });

  it('keeps contextual choices and their delegation eligibility wired into the transcript', () => {
    expect(source).toContain('<FollowUpChoices');
    expect(source).toContain('canDelegate={canDelegateFollowUp}');
    expect(source).toContain('canOfferSubagent(session, delegationStrategy)');
    expect(source).toContain('onSend={text => { void send(text); }}');
  });
});
