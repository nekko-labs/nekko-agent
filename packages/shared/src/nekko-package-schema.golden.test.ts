import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MOD_PERMISSIONS, PACKAGE_KINDS } from './nekko-package.js';

// The published schema is for authors; the parser is what the app trusts. Keep their lists in step.
const schema = JSON.parse(readFileSync(new URL('../schemas/nekko-package-1.json', import.meta.url), 'utf8'));

describe('nekko-package-1.json', () => {
  it('lists the same kinds and permissions as the parser', () => {
    expect(schema.properties.kind.enum).toEqual([...PACKAGE_KINDS]);
    expect(schema.properties.permissions.items.enum).toEqual([...MOD_PERMISSIONS]);
  });

  it('matches the parser on paths', () => {
    const path = new RegExp(schema.$defs.path.pattern);
    for (const p of ['panel.html', 'a/b.js', 'x']) expect(path.test(p)).toBe(true);
    for (const p of ['../x', 'a/../x', '/x', 'C:/x', 'a\\b', 'a/./b', 'a//b', 'a/']) expect(path.test(p)).toBe(false);
  });
});
