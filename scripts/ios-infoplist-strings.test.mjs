import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Xcode compiles a key with no source-language entry in a String Catalog to
// `"Key" = "Key";`, and App Store Connect rejects that as a purpose string
// (ITMS-90738). Every key in the InfoPlist catalog needs a real English value.
const catalog = JSON.parse(readFileSync(new URL('../apps/ios/App/InfoPlist.xcstrings', import.meta.url), 'utf8'));
const plist = readFileSync(new URL('../apps/ios/Info.plist', import.meta.url), 'utf8');

test('every Info.plist purpose string has an English entry matching Info.plist', () => {
  const source = catalog.sourceLanguage;
  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (!/^NS\w+UsageDescription$/.test(key)) continue;
    const value = entry.localizations?.[source]?.stringUnit?.value;
    assert.ok(value && value !== key, `${key} has no ${source} value`);
    const inPlist = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
    assert.equal(value, inPlist, `${key}: ${source} catalog value differs from Info.plist`);
  }
});

test('every purpose string in Info.plist is in the catalog', () => {
  for (const [, key] of plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)) {
    assert.ok(catalog.strings[key], `${key} is missing from InfoPlist.xcstrings`);
  }
});
