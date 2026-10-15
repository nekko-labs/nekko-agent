import { describe, expect, it } from 'vitest';
import { summarizeChanges } from './changeSummary.js';

describe('agent change summary', () => {
  it('counts insertions, deletions and replacements across files', () => {
    expect(summarizeChanges([{ path: 'a', original: 'keep\nold', current: 'keep\nnew\nextra' }, { path: 'b', original: '', current: 'hello' }])).toEqual({ files: 2, added: 3, removed: 1 });
  });
  it('does not count moved matching or unchanged lines as replacements', () => {
    expect(summarizeChanges([{ path: 'a', original: 'a\nb\nc', current: 'a\nx\nb\nc' }])).toEqual({ files: 1, added: 1, removed: 0 });
    expect(summarizeChanges([])).toEqual({ files: 0, added: 0, removed: 0 });
    expect(summarizeChanges([{ path: 'a', original: 'same\n', current: 'same\n' }])).toEqual({ files: 1, added: 0, removed: 0 });
  });
  it('handles deleted and empty files', () => {
    expect(summarizeChanges([{ path: 'a', original: 'a\nb', current: '' }])).toEqual({ files: 1, added: 0, removed: 2 });
  });
});
