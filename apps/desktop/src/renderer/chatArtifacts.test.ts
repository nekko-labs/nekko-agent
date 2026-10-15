import { describe, it, expect } from 'vitest';
import { chatArtifacts } from './chatArtifacts.js';

describe('chat artifacts', () => {
  it('uses descriptive labels and resolves local paths once', () => {
    expect(chatArtifacts('[Disk audit and cleanup proposal](reports/disk-audit/README.md)\n[Again](reports/disk-audit/README.md)', 'C:/project')).toEqual([{ path: 'C:/project/reports/disk-audit/README.md', title: 'Disk audit and cleanup proposal', filename: 'README.md' }]);
  });
  it('gives generic names a useful folder-based title', () => {
    expect(chatArtifacts('[README.md](/reports/disk-audit/README.md)')[0].title).toBe('Disk audit');
  });
  it('ignores remote resources, executable files, code and images', () => {
    expect(chatArtifacts('[Remote](https://example.com/a.md) [Run](/a.exe) ![Image](/image.svg) ` [Code](/a.md)`\n```\n[Code](/b.md)\n```')).toEqual([]);
    expect(chatArtifacts('[Relative](report.md)')).toEqual([]);
  });
});
