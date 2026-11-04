// Encode the first N frames of a switch dir as a GIF for before/after evidence.
const fs = require('node:fs');
const path = require('node:path');
const writeGif = require('./evidence-gif.cjs');
const [dir, outFile, countArg] = process.argv.slice(2);
if (!dir || !outFile) { console.error('usage: make-switch-gif <frames dir> <out.gif> [n]'); process.exit(2); }
const count = countArg ? Number(countArg) : 8;
const frames = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().slice(0, count).map(f => fs.readFileSync(path.join(dir, f)));
writeGif(outFile, frames, 8);
console.log('wrote', outFile, 'from', frames.length, 'frames');
