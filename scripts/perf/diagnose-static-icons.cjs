// Diagnostic ablation only. Never ship: test animated SVG mount/render cost.
const fs = require('node:fs');
const p = 'apps/desktop/src/renderer/gentleface-icons.tsx';
let s = fs.readFileSync(p, 'utf8');
const a = '  const motion = GENTLEFACE_MOTION[name];';
if (!s.includes(a)) throw Error('Missing motion selection anchor');
s = s.replace(a, '  const motion = undefined as (typeof GENTLEFACE_MOTION)[GfIconName] | undefined;');
fs.writeFileSync(p, s);
