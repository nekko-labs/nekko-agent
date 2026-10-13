import { describe, expect, it } from 'vitest';
import { folderPathKey, sameFolderPath, uniqueFolders } from './workspace.js';

describe('folder identity', () => {
  it('treats case, separator style and a trailing slash as the same Windows folder', () => {
    expect(sameFolderPath('C:\\Users\\p\\code', 'c:/users/p/code/')).toBe(true);
    expect(sameFolderPath('\\\\server\\Share', '\\\\SERVER\\share\\')).toBe(true);
    expect(folderPathKey('C:\\')).toBe('c:\\');
  });

  it('keeps case on POSIX paths', () => {
    expect(sameFolderPath('/home/a/code', '/home/a/code/')).toBe(true);
    expect(sameFolderPath('/home/a', '/home/A')).toBe(false);
  });

  it('keeps the first of each folder and maps the rest to it', () => {
    const out = uniqueFolders([
      { id: 'a', path: 'C:\\code' }, { id: 'b', path: 'C:\\code\\app' }, { id: 'c', path: 'c:\\CODE\\' }, { id: 'a', path: 'C:\\code' },
    ]);
    expect(out.folders.map((f) => f.id)).toEqual(['a', 'b']);
    expect(out.aliases).toEqual({ c: 'a' });
  });
});
