import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
const path = new URL('../apps/desktop/src/renderer/subagentActivity.ts', import.meta.url);
const source = readFileSync(path, 'utf8');
const functionSource = source.slice(source.indexOf('export function compactSentence'), source.indexOf('export function foldSubagentActivity'));
const { code } = await transform(functionSource.replace('export function', 'function') + '\nglobalThis.compact = compactSentence;', { loader: 'ts' });
new Function(code)();
const compact = globalThis.compact;
const baseline = (text, limit = 140) => {
  const clean = text.slice(0, 2000).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const sentence = clean.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? clean;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
};
let seed = 12345;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const chars = ['word', ' ', '\n', '\t', '\0', '\x7f', '\u00a0', '\u2003', '\ufeff', '.', '!', '?', '猫', '😀'];
for (let i = 0; i < 10000; i++) {
  let text = '';
  for (let j = random() % 2500; j > 0; j--) text += chars[random() % chars.length];
  const limit = [1, 2, 4, 40, 140, 400, 2000, 3000][i % 8];
  if (baseline(text, limit) !== compact(text, limit)) throw Error(`Mismatch ${JSON.stringify({ text, limit })}`);
}
console.log('10,000 seeded differential cases passed');
const texts = Array.from({ length: 400 }, (_, i) => ('streaming words without a sentence boundary '.repeat(60)).slice(-1600 - i));
for (const [name, fn] of [['before', baseline], ['after', compact]]) {
  let sum = 0;
  for (let j = 0; j < 10000; j++) sum += fn(texts[j % texts.length]).length;
  const times = [];
  for (let lap = 0; lap < 5; lap++) {
    const start = performance.now();
    for (let i = 0; i < 100000; i++) sum += fn(texts[i % texts.length]).length;
    times.push(Number((performance.now() - start).toFixed(2)));
  }
  console.log(JSON.stringify({ name, callsPerLap: 100000, ms: times, checksum: sum }));
}
