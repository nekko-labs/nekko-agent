import { describe, expect, it } from 'vitest';
import { endsOnUnlabelledQuestion, speaksToUser, topicLine } from './replyTopics.js';

describe('topicLine', () => {
  it.each([
    ['**Next step**: merge it', 'next', 'Next step', 'merge it'],
    ['**Next step:** merge it', 'next', 'Next step', 'merge it'],
    ['**Changes**', 'summary', 'Changes', ''],
    ['**Not verified / blocked**: Windows', 'summary', 'Not verified / blocked', 'Windows'],
    ['**Run this**', 'command', 'Run this', ''],
    ['**Decision**: kept the timeout', 'decision', 'Decision', 'kept the timeout'],
    ['## Open questions', 'question', 'Open questions', ''],
    ['### **Next steps:**', 'next', 'Next steps', ''],
  ])('reads %s', (line, topic, label, rest) => {
    expect(topicLine(line)).toEqual({ topic, label, rest });
  });

  it.each([
    '**Changes** to the plan come later',
    '**Important**: not a topic we name',
    'Next step: plain words are not a label',
    '## Installation',
    '- **Next step**: a list item',
  ])('leaves %s alone', (line) => {
    expect(topicLine(line)).toBeNull();
  });
});

describe('speaksToUser', () => {
  it('hears a message that stops on a question', () => {
    expect(speaksToUser('The signup test has the same timer.\n\nShould I fix it here too?')).toBe(true);
    expect(speaksToUser('Does this look right?**')).toBe(true);
    expect(speaksToUser('これでいいですか？')).toBe(true);
  });

  it('hears a label anywhere in the message', () => {
    expect(speaksToUser('Found it.\n\n**Decision**: kept the timeout.\n\nMoving on.')).toBe(true);
  });

  it('leaves a progress note quiet', () => {
    expect(speaksToUser('I will read the test first.')).toBe(false);
    expect(speaksToUser('Why did it pass locally? The runner is slower, so I am checking that.')).toBe(false);
  });

  it('ignores code', () => {
    expect(speaksToUser('Checking this.\n\n```md\n**Next step**: inside a fence\n```\n\nReading on.')).toBe(false);
    expect(speaksToUser('Running:\n```sh\ntest -f x?\n```')).toBe(false);
  });
});

describe('endsOnUnlabelledQuestion', () => {
  it('finds a closing question with no label', () => {
    expect(endsOnUnlabelledQuestion('All green.\n\nWant me to open the PR?')).toBe(true);
    expect(endsOnUnlabelledQuestion('Pick one?\n\n```bash\nnpm test\n```')).toBe(true);
  });

  it('stays out when a label already announces it', () => {
    expect(endsOnUnlabelledQuestion('**Question**\n\nWant me to open the PR?')).toBe(false);
    expect(endsOnUnlabelledQuestion('**Next step**: want me to open the PR?')).toBe(false);
    expect(endsOnUnlabelledQuestion('**Decision**: did that break it?')).toBe(false);
  });

  it('stays out when the message closes on a statement', () => {
    expect(endsOnUnlabelledQuestion('Did it pass? It did.')).toBe(false);
  });
});
