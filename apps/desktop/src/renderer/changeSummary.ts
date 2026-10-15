import type { FileChange } from '@nekko-agent/shared';

/** Exact line counts with linear memory. Trim unchanged edges before comparing. */
export function summarizeChanges(changes: FileChange[]) {
  let added = 0, removed = 0;
  for (const change of changes) {
    const a = change.original ? change.original.split('\n') : [];
    const b = change.current ? change.current.split('\n') : [];
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const row = new Uint32Array(endB - start + 1);
    for (let i = start; i < endA; i++) {
      let diagonal = 0;
      for (let j = start; j < endB; j++) {
        const index = j - start + 1, previous = row[index];
        row[index] = a[i] === b[j] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
        diagonal = previous;
      }
    }
    const common = row[row.length - 1];
    added += endB - start - common;
    removed += endA - start - common;
  }
  return { files: changes.length, added, removed };
}
