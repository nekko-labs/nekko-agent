// Diagnostic-only patch for #712. Applied to the recorded exact-base worktree.
const fs = require('node:fs');
const file = 'apps/desktop/src/renderer/gentleface-icons.tsx';
let source = fs.readFileSync(file, 'utf8');
const before = `    stop();
    control?.addEventListener('pointerenter', hover);`;
const after = `    svg.pauseAnimations();
    control?.addEventListener('pointerenter', hover);`;
const cleanupBefore = `    return () => {
      stop();
      control?.removeEventListener('pointerenter', hover);`;
const cleanupAfter = `    return () => {
      clearTimeout(timer);
      svg.pauseAnimations();
      control?.removeEventListener('pointerenter', hover);`;
if (!source.includes(before) || !source.includes(cleanupBefore)) throw Error('Exact-base icon implementation changed');
source = source.replace(before, after).replace(cleanupBefore, cleanupAfter);
fs.writeFileSync(file, source);
