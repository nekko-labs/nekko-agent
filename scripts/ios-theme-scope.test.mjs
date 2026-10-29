import assert from 'node:assert/strict';
import { test } from 'node:test';
import { themeScope } from './ios-theme-scope.mjs';

const diff = (file, ...lines) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', ...lines].join('\n');

test('a text edit beside an unchanged colour stays light only', () => {
  assert.equal(themeScope(diff('apps/ios/App/Views/Chat.swift',
    '-        Text("Hello").foregroundStyle(palette.ink)',
    '+        Text("Hello there").foregroundStyle(palette.ink)')), 'light');
});

test('a palette swap or a new coloured view runs both appearances', () => {
  assert.equal(themeScope(diff('apps/ios/App/Views/Chat.swift',
    '-        Text("Hi").foregroundStyle(palette.ink)',
    '+        Text("Hi").foregroundStyle(palette.inkSoft)')), 'light dark');
  assert.equal(themeScope(diff('apps/ios/App/Views/New.swift',
    '+        Rectangle().fill(Color(red: 1, green: 0, blue: 0))')), 'light dark');
  assert.equal(themeScope(diff('apps/ios/App/Views/New.swift',
    '+        .background(.ultraThinMaterial)')), 'light dark');
});

test('theme sources and colour sets always run both, an app icon does not', () => {
  assert.equal(themeScope(diff('apps/ios/App/Platform/Theme.swift', '+// comment')), 'light dark');
  assert.equal(themeScope(diff('apps/ios/App/Platform/ThemePresets.swift', '+// comment')), 'light dark');
  assert.equal(themeScope(diff('apps/ios/App/Assets.xcassets/Accent.colorset/Contents.json', '+{}')), 'light dark');
  assert.equal(themeScope(diff('apps/ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json', '+{}')), 'light');
});

test('moving a coloured line between files counts, non-Swift files and no diff do not', () => {
  assert.equal(themeScope(diff('apps/ios/App/A.swift', '-x.foregroundStyle(palette.ink)') + '\n' +
    diff('apps/ios/App/B.swift', '+x.foregroundStyle(palette.ink)')), 'light dark');
  assert.equal(themeScope(diff('apps/ios/README.md', '+Color.red is the warning colour')), 'light');
  assert.equal(themeScope(''), 'light');
});
