// Live check for the hardware profile and model recommendations on real
// hardware: a real nekkod (no TS backend, scratch data dir and home) probes
// this machine (`machine:profile`) and recommends a model per task from the
// bundled feed (`machine:recommendations`). Run it on each machine the
// acceptance criteria name (Windows/NVIDIA, Windows/AMD on Vulkan, Apple
// Silicon, CPU only) and read the picks.
// Usage: node scripts/itest-recommendations.mjs [path/to/nekkod]
import { startNekkod } from './itest-nekkod.mjs';

const GB = (b) => (b == null ? '?' : `${(b / 1024 ** 3).toFixed(1)} GiB`);
const daemon = await startNekkod({ nekkod: process.argv[2], label: 'recs' });
const finish = async (code) => {
  await daemon.stop();
  process.exit(code);
};
process.on('unhandledRejection', async (e) => {
  console.error(e);
  await finish(1);
});

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

const t0 = performance.now();
const profile = await daemon.call('machine:profile');
const probeMs = performance.now() - t0;
const t1 = performance.now();
const saved = await daemon.call('machine:profile');
const savedMs = performance.now() - t1;

console.log(`${profile.platform}/${profile.arch}  ${profile.cpu.model ?? 'CPU'} x${profile.cpu.cores}  RAM ${GB(profile.ramBytes)}${profile.unified ? ' (unified)' : ''}`);
for (const g of profile.gpus) console.log(`  GPU ${g.name}  ${GB(g.vramBytes)}${g.cores ? `  ${g.cores} cores` : ''}`);
console.log(`  backends ${profile.backends.join(', ')}  engine ${profile.engine ? `${profile.engine.backend} ${profile.engine.version ?? ''}` : 'none'}`);
check('profile probed', profile.format === 1 && profile.ramBytes > 0);
check('second answer is the saved profile', saved.probedAt === profile.probedAt, `probe ${probeMs.toFixed(0)} ms, saved ${savedMs.toFixed(0)} ms`);

const recs = await daemon.call('machine:recommendations');
console.log(`\nfeed ${recs.feedVersion}  hardware ${recs.hardware.classId ?? 'not in the table'} (${recs.hardware.device ?? 'no GPU'}, ${recs.hardware.backend}${recs.hardware.bandwidthGBps ? `, ${recs.hardware.bandwidthGBps} GB/s` : ''})  budget ${GB(recs.budget.bytes)} ${recs.budget.placement}`);
for (const t of recs.tasks) {
  const p = t.pick;
  const speed = p?.speed ? `${p.speed.basis === 'measured' ? '' : '~'}${p.speed.tokensPerSecond} tok/s (${p.speed.basis})` : '';
  console.log(`  ${t.task.padEnd(9)} ${p ? `${p.name} ${p.quant}`.padEnd(32) : '-'.padEnd(32)} ${p ? `${GB(p.memoryBytes)} of memory, ${GB(p.headroomBytes)} left, ${GB(p.downloadBytes)} download` : ''}  ${speed}${t.belowTargetSpeed ? '  BELOW TARGET' : ''}`);
  check(`${t.task}: a pick that fits`, !!p && p.fit !== 'tooBig' && p.headroomBytes >= 0);
  if (t.minTokensPerSecond != null && recs.hardware.classId) check(`${t.task}: an expected speed`, !!p?.speed);
}

await finish(failures ? 1 : 0);
