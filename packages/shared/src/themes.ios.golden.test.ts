import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { THEME_PRESETS } from './themes.js';

/**
 * The iPhone draws the desktop's theme presets from its own copy,
 * `apps/ios/App/Platform/ThemePresets.swift`, written from THEME_PRESETS.
 * Fails when the copy is stale; rewrite it with UPDATE_GOLDEN=1.
 */
const path = join(__dirname, '..', '..', '..', 'apps', 'ios', 'App', 'Platform', 'ThemePresets.swift');

function hex(v: string | undefined): string {
  return v ? `0x${v.slice(1).toUpperCase()}` : 'nil';
}

function swift(): string {
  const rows = THEME_PRESETS.map((p) => {
    const fields = [
      `id: "${p.id}"`,
      `label: "${p.label}"`,
      `mode: .${p.mode}`,
      `accent: ${hex(p.accent)}`,
      `accent2: ${hex(p.accent2)}`,
      `family: ${p.familyLabel ? `"${p.familyLabel}"` : 'nil'}`,
      `paper: ${hex(p.paper)}`,
      `surface: ${hex(p.surface)}`,
      `surface2: ${hex(p.surface2)}`,
      `ink: ${hex(p.ink)}`,
      `inkSoft: ${hex(p.inkSoft)}`,
      `inkFaint: ${hex(p.inkFaint)}`,
      `line: ${hex(p.line)}`,
    ];
    return `        ThemePreset(${fields.join(', ')}),`;
  });
  return [
    '// Written by packages/shared/src/themes.ios.golden.test.ts from THEME_PRESETS',
    '// (packages/shared/src/themes.ts). Do not edit: change the desktop catalog and',
    '// rerun the test with UPDATE_GOLDEN=1.',
    '',
    'extension ThemePreset {',
    '    static let all: [ThemePreset] = [',
    ...rows,
    '    ]',
    '}',
    '',
  ].join('\n');
}

it('writes the theme presets the iPhone draws', () => {
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, swift());
  expect(readFileSync(path, 'utf8')).toBe(swift());
});
