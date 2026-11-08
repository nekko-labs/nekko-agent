import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

// The SDK lint check validates XML; this cheap check also protects key/format parity.
const root = new URL('../apps/android/app/src/main/res/', import.meta.url);
function strings(locale, group) {
  const xml = readFileSync(new URL(`${locale}/${group}_strings.xml`, root), 'utf8');
  assert.doesNotMatch(xml, /translatable="false"|tools:ignore/);
  const entries = [...xml.matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)];
  assert.equal(new Set(entries.map((m) => m[1])).size, entries.length, 'unique keys');
  return new Map(entries.map((m) => [m[1], m[2]]));
}
for (const locale of ['de', 'es', 'fr', 'pt', 'ja', 'b+zh+Hans']) {
  for (const group of ['voice', 'image']) {
    test(`${locale} ${group} UI strings cover every default key and preserve arguments`, () => {
      const source = strings('values', group);
      const translated = strings(`values-${locale}`, group);
      assert.deepEqual([...translated.keys()].sort(), [...source.keys()].sort());
      for (const [key, value] of source) {
        const text = translated.get(key);
        assert.ok(text.trim(), key);
        assert.deepEqual(text.match(/%\d+\$[ds]/g) ?? [], value.match(/%\d+\$[ds]/g) ?? [], key);
      }
    });
  }
}
