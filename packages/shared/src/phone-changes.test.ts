import { describe, expect, it } from 'vitest';
import { phoneChannelAllowed } from './phone-access.js';
import {
  hunksOf,
  lineOps,
  phoneChangesView,
  phoneDisplayPath,
  phoneSecretFile,
  PHONE_CHANGES_VIEW,
} from './phone-changes.js';

describe('phone Changes view', () => {
  it('diffs a modified file into hunks with context', () => {
    const original = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n') + '\n';
    const current = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const view = phoneChangesView([{ path: '/Users/me/work/app/src/main.ts', original, current }]);
    expect(view.files).toEqual([
      {
        path: '…/src/main.ts',
        status: 'modified',
        added: 2,
        removed: 1,
        hunks: [{ oldStart: 2, newStart: 2, lines: [' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', ' i', '+j'] }],
      },
    ]);
  });

  it('keeps hunks apart when their context does not touch', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const b = [...a];
    b[1] = 'X';
    b[18] = 'Y';
    const h = hunksOf(lineOps(a, b));
    expect(h.map((x) => [x.oldStart, x.lines.length])).toEqual([[1, 6], [16, 6]]);
  });

  it('marks a new file as added and skips unchanged ones', () => {
    const v = phoneChangesView([
      { path: 'C:\\code\\app\\new.txt', original: '', current: 'one\ntwo' },
      { path: '/x/same.txt', original: 'z', current: 'z' },
    ]);
    expect(v.files).toEqual([{ path: '…/app/new.txt', status: 'added', added: 2, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ['+one', '+two'] }] }]);
  });

  it('counts secret files but never sends their content', () => {
    for (const p of ['/w/.env', '/w/.env.local', '/home/u/.ssh/config', '/w/certs/server.pem', '/w/id_ed25519', '/w/.npmrc', '/home/u/.aws/credentials']) {
      expect(phoneSecretFile(p), p).toBe(true);
    }
    expect(phoneSecretFile('/w/src/environment.ts')).toBe(false);
    const v = phoneChangesView([{ path: '/w/.env', original: 'A=1\n', current: 'A=2\n' }]);
    expect(v.files[0]).toEqual({ path: 'w/.env', status: 'modified', added: 1, removed: 1, hunks: [], hidden: true });
  });

  it('says how big a file is instead of sending too much, and counts files past the limit', () => {
    const big = Array.from({ length: PHONE_CHANGES_VIEW.linesPerFile + 10 }, (_, i) => `n${i}`).join('\n');
    const many = Array.from({ length: PHONE_CHANGES_VIEW.files + 2 }, (_, i) => ({ path: `/w/f${i}.txt`, original: '', current: 'x' }));
    const v = phoneChangesView([{ path: '/w/big.txt', original: '', current: big }, ...many]);
    expect(v.files[0]).toMatchObject({ tooLarge: true, lines: PHONE_CHANGES_VIEW.linesPerFile + 10, hunks: [] });
    expect(v.files).toHaveLength(PHONE_CHANGES_VIEW.files);
    expect(v.omittedFiles).toBe(3);
  });

  it('flags binary content', () => {
    expect(phoneChangesView([{ path: '/w/a.bin', original: 'a\u0000', current: 'b\u0000' }]).files[0].binary).toBe(true);
  });

  it('shows only the last two path segments', () => {
    expect(phoneDisplayPath('/a/b/c/d.ts')).toBe('…/c/d.ts');
    expect(phoneDisplayPath('d.ts')).toBe('d.ts');
  });

  it('falls back to removed-then-added when a region is too big to compare', () => {
    expect(lineOps(['a', 'x', 'y', 'z'], ['a', 'p', 'q'], 1).map((o) => o.t + o.line)).toEqual([' a', '-x', '-y', '-z', '+p', '+q']);
  });
});

describe('changes:list from a phone', () => {
  it('never lets a phone accept changes or read files', () => {
    for (const ch of ['changes:accept', 'changes:acceptAll', 'file:read', 'file:write', 'dir:list']) {
      expect(phoneChannelAllowed(ch), ch).toBe(false);
    }
  });
});
