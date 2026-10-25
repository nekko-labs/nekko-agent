// Which appearances Native iOS (ios-native.yml) verifies on a pull request:
// "light", or "light dark" when the change touches colours. The live journey
// costs about 5 minutes per appearance, and a plain UI change looks the same in
// both, so dark runs only when it can differ. The schedule, a dispatch and the
// `ci:theme` label always run both (decided in the workflow, not here).
//
// A change touches colours when it edits the theme sources or a colour set,
// or when the colour references in a Swift file's removed lines and added
// lines differ (a palette swap, a new coloured view). Editing a line that
// keeps its colours, such as a label's text beside `palette.ink`, does not count.
//
// Usage: git diff <base> <head> -- apps/ios | node scripts/ios-theme-scope.mjs

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const THEME_FILES = [/^apps\/ios\/.*Theme[^/]*\.swift$/, /^apps\/ios\/.*\.colorset\//];
const COLOR = /\bpalette\.\w+|\b(?:UI)?Color\b(?:\.\w+|\([^)]*\))?|\bcolorScheme\b|\.preferredColorScheme\b|\b\w+Material\b/g;

/** "light dark" when the unified diff changes colours, else "light". */
export function themeScope(diff) {
  let file = '';
  const removed = new Map();
  const added = new Map();
  const count = (map, line) => {
    for (const token of line.match(COLOR) ?? []) map.set(`${file} ${token}`, (map.get(`${file} ${token}`) ?? 0) + 1);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = line.split(' b/')[1] ?? '';
      if (THEME_FILES.some(p => p.test(file))) return 'light dark';
    } else if (!file.endsWith('.swift') || line.startsWith('+++') || line.startsWith('---')) {
      continue;
    } else if (line.startsWith('-')) count(removed, line);
    else if (line.startsWith('+')) count(added, line);
  }
  const keys = new Set([...removed.keys(), ...added.keys()]);
  return [...keys].some(k => removed.get(k) !== added.get(k)) ? 'light dark' : 'light';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(themeScope(readFileSync(0, 'utf8')));
}
