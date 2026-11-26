import { describe, expect, it } from 'vitest';
import type { CatalogQuant, LocalModel } from '@nekko-agent/shared';
import { isInstalledBuild, releasesOf } from './ModelDetail.js';

const build = (file: string, label: string, variant?: string): CatalogQuant =>
  variant === undefined ? { label, file } : { label, file, variant, quant: label.split(' ').pop() };
const local = (path: string, quantization = 'Q8_0'): LocalModel =>
  ({ id: path, name: path, path, sizeBytes: 1, addedAt: 0, loaded: false, quantization }) as LocalModel;

describe('a repo with several releases of one model', () => {
  const quants = [
    build('M-v2.1-Q8_0.gguf', 'v2.1 Q8_0', 'v2.1'),
    build('M-v2-Q8_0.gguf', 'v2 Q8_0', 'v2'),
    build('M-Q8_0.gguf', 'Q8_0'),
  ];

  it('groups builds by release, in catalog order, the unmarked one as its own group', () => {
    expect(releasesOf(quants).map((g) => [g.variant, g.quants.map((q) => q.file)])).toEqual([
      ['v2.1', ['M-v2.1-Q8_0.gguf']],
      ['v2', ['M-v2-Q8_0.gguf']],
      ['', ['M-Q8_0.gguf']],
    ]);
  });

  it('marks only the release that is downloaded as in the library', () => {
    const have = local('/models/vision/o_M-GGUF/M-Q8_0.gguf');
    expect(quants.map((q) => isInstalledBuild(have, q, true))).toEqual([false, false, true]);
  });
});

describe('a repo with one release', () => {
  it('is one unnamed group, matched by quantization as before', () => {
    const quants = [build('M-Q4_K_M.gguf', 'Q4_K_M'), build('M-Q8_0.gguf', 'Q8_0')];
    expect(releasesOf(quants)).toEqual([{ quants }]);
    expect(isInstalledBuild(local('elsewhere.gguf', 'Q8_0'), quants[1], false)).toBe(true);
  });
});
