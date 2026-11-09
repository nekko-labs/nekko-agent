import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppIcon } from './appIcon.js';

const mainDir = join('/repo/apps/desktop/out/main');
const built = join('/repo/apps/desktop/out/renderer/icon-512.png');
const source = join('/repo/apps/desktop/src/renderer/public/icon-512.png');
const both = (path: string) => path === built || path === source;

describe('app icon', () => {
  it('reads the source icon in a dev run, not a stale out/renderer copy', () => {
    expect(resolveAppIcon(mainDir, false, both)).toBe(source);
  });

  it('reads the built renderer icon in a packaged app', () => {
    expect(resolveAppIcon(mainDir, true, both)).toBe(built);
  });

  it('falls back to whichever icon exists', () => {
    expect(resolveAppIcon(mainDir, false, (path) => path === built)).toBe(built);
    expect(resolveAppIcon(mainDir, true, (path) => path === source)).toBe(source);
    expect(resolveAppIcon(mainDir, true, () => false)).toBeUndefined();
  });
});
