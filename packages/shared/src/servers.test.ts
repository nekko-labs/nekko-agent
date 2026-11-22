import { describe, expect, it } from 'vitest';
import { siteFolder, siteName } from './servers.js';

describe('served sites', () => {
  const folders = [
    { id: 'code', path: '/code' },
    { id: 'shop', path: '/code/shop/' },
    { id: 'win', path: 'C:\\Users\\me\\site' },
  ];

  it('tags a site with the deepest connected folder holding its working folder', () => {
    expect(siteFolder({ cwd: '/code/shop/web' }, folders)?.id).toBe('shop');
    expect(siteFolder({ cwd: '/code/shop' }, folders)?.id).toBe('shop');
    expect(siteFolder({ cwd: '/code/other' }, folders)?.id).toBe('code');
    // A sibling whose name starts the same is not inside.
    expect(siteFolder({ cwd: '/code/shopfront' }, folders)?.id).toBe('code');
    expect(siteFolder({ cwd: '/tmp' }, folders)).toBeUndefined();
    expect(siteFolder({}, folders)).toBeUndefined();
  });

  it('matches Windows paths without case', () => {
    expect(siteFolder({ cwd: 'c:/users/ME/site/app' }, folders)?.id).toBe('win');
  });

  it('names a site by its title, else its address', () => {
    expect(siteName({ title: '  Shop ', port: 5173 })).toBe('Shop');
    expect(siteName({ title: '', port: 8000 })).toBe('localhost:8000');
  });
});
