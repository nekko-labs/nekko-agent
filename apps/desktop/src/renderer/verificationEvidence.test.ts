import { describe, expect, it } from 'vitest';
import { verificationPairs } from './verificationEvidence.js';

const pair = '![Before: Navbar](/tmp/before.png)\n![After: Navbar](/tmp/after.png)';
describe('reply-scoped verification pairs', () => {
  it('pairs matching explicit labels, preserving order and paths', () => {
    expect(verificationPairs(pair)).toEqual([{ surface: 'Navbar', before: { src: '/tmp/before.png', label: 'Before: Navbar' }, after: { src: '/tmp/after.png', label: 'After: Navbar' } }]);
  });
  it('supports Windows paths and remote URLs without fetching them', () => {
    expect(verificationPairs('![Before header](C:/shots/b.png)\n![After header](https://example.com/a.png)')).toHaveLength(1);
  });
  it('does not infer from filenames, combine different surfaces or invent missing states', () => {
    expect(verificationPairs('![Screenshot](/tmp/before.png)\n![Screenshot](/tmp/after.png)')).toEqual([]);
    expect(verificationPairs('![Before: A](/tmp/b.png)\n![After: B](/tmp/a.png)')).toEqual([]);
    expect(verificationPairs('![After: New screen](/tmp/a.png)')).toEqual([]);
    expect(verificationPairs(pair.split('\n')[0])).toEqual([]);
  });
  it('excludes code samples, incomplete markdown, duplicate pairs and unsafe paths', () => {
    expect(verificationPairs('```md\n' + pair + '\n```')).toEqual([]);
    expect(verificationPairs('`![Before](/tmp/b.png)`\n`![After](/tmp/a.png)`')).toEqual([]);
    expect(verificationPairs('![Before](javascript:x)\n![After](https://example.com/a.png)')).toEqual([]);
    expect(verificationPairs('![Before](/tmp/b.png)\n![After](/tmp/b.png)')).toEqual([]);
    expect(verificationPairs(pair + '\n' + pair)).toHaveLength(1);
    expect(verificationPairs('![Before](/tmp/b.png)\n![After](')).toEqual([]);
  });
  it('does not carry evidence between replies or sessions', () => {
    expect(verificationPairs(pair)).toHaveLength(1);
    expect(verificationPairs('**Next step**\nReview it.')).toEqual([]);
  });
});
