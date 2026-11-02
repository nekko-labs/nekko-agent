import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { THEME_PRESETS } from './themes.js';

/**
 * The Android app draws the desktop's theme presets from its own copy,
 * `apps/android/app/src/main/java/com/nekko/android/ui/theme/ThemePresets.kt`,
 * written from THEME_PRESETS as the iPhone's is (themes.ios.golden.test.ts).
 * Fails when the copy is stale; rewrite it with UPDATE_GOLDEN=1.
 */
const path = join(
  __dirname, '..', '..', '..', 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'nekko', 'android', 'ui', 'theme', 'ThemePresets.kt',
);

function argb(v: string | undefined): string {
  return v ? `0xFF${v.slice(1).toUpperCase()}` : 'null';
}

function kotlin(): string {
  const rows = THEME_PRESETS.map((p) => {
    const fields = [
      `"${p.id}"`,
      `"${p.label}"`,
      `ThemePreset.Mode.${p.mode.toUpperCase()}`,
      `accent = ${argb(p.accent)}`,
      `accent2 = ${argb(p.accent2)}`,
      `family = ${p.familyLabel ? `"${p.familyLabel}"` : 'null'}`,
      `paper = ${argb(p.paper)}`,
      `surface = ${argb(p.surface)}`,
      `surface2 = ${argb(p.surface2)}`,
      `ink = ${argb(p.ink)}`,
      `inkSoft = ${argb(p.inkSoft)}`,
      `inkFaint = ${argb(p.inkFaint)}`,
      `line = ${argb(p.line)}`,
    ];
    return `    ThemePreset(${fields.join(', ')}),`;
  });
  return [
    '// Written by packages/shared/src/themes.android.golden.test.ts from THEME_PRESETS',
    '// (packages/shared/src/themes.ts). Do not edit: change the desktop catalog and',
    '// rerun the test with UPDATE_GOLDEN=1.',
    '',
    'package com.nekko.android.ui.theme',
    '',
    '/** The desktop\'s theme presets, in its order. */',
    'val THEME_PRESETS: List<ThemePreset> = listOf(',
    ...rows,
    ')',
    '',
  ].join('\n');
}

it('writes the theme presets Android draws', () => {
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, kotlin());
  expect(readFileSync(path, 'utf8')).toBe(kotlin());
});
