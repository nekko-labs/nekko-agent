// Live check for the AN9b machine-readiness advisor on real hardware: a real
// nekkod (no TS backend, scratch data dir and home) gathers MachineFacts
// through its probes and evaluates this machine against the curated
// offline-stack catalog (`machine:readiness`). The device checks expect the
// RTX 5090 Windows box. Usage: node scripts/itest-readiness.mjs [path/to/nekkod]
import { startNekkod } from './itest-nekkod.mjs';

const GB = (b) => (b == null ? '?' : `${(b / 1e9).toFixed(1)} GB`);
const daemon = await startNekkod({ nekkod: process.argv[2], label: 'ready' });
const finish = async (code) => {
  await daemon.stop();
  process.exit(code);
};
process.on('unhandledRejection', async (e) => {
  console.error(e);
  await finish(1);
});

const report = await daemon.call('machine:readiness');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

console.log(`verdict: ${report.verdict}  (catalog ${report.catalogVersion})`);
for (const a of report.roles) {
  console.log(`  ${a.role.padEnd(7)} ${a.verdict.padEnd(12)} pick: ${a.pick?.name ?? '-'}  reasons: ${a.reasons.map((r) => r.code + (r.detail ? `:${r.detail}` : '')).join(', ')}`);
}
console.log(`  combined: memory ${GB(report.combined.memoryBytes)} of ${GB(report.combined.budgetBytes)} budget; install ${GB(report.combined.installBytes)} of ${GB(report.combined.diskFreeBytes)} disk`);
console.log(`  unknowns: ${report.unknowns.join(', ') || '(none)'}`);
console.log(`  report reasons: ${report.reasons.map((r) => r.code).join(', ') || '(none)'}`);

check('report covers all four roles', ['runtime', 'intent', 'stt', 'tts'].every((r) => report.roles.some((a) => a.role === r)));
check('every role has a pick on this machine', report.roles.every((a) => a.pick));
check('combined memory is positive and under budget', report.combined.memoryBytes > 0 && report.combined.memoryBytes < report.combined.budgetBytes);
check('catalog version stamped on the report', typeof report.catalogVersion === 'string' && report.catalogVersion.length > 0);

// This box (win32 x64, RTX 5090, no CPUID probe): the CUDA runtime is picked but
// capped unverified because cpuFeatures could not be read without native code.
const runtime = report.roles.find((a) => a.role === 'runtime');
const intent = report.roles.find((a) => a.role === 'intent');
check('cuda runtime selected', runtime?.pick?.id === 'llama-server-cuda', runtime?.pick?.id);
check('intent pick is a GPU-resident model', intent?.pick != null && intent.pick.memoryBytes > 1e9, intent?.pick?.id);

// Language filtering exercises the catalog live.
const ja = await daemon.call('machine:readiness', 'ja');
const jaStt = ja.roles.find((a) => a.role === 'stt');
check('ja STT pick covers Japanese', jaStt?.pick?.id === 'whisper-small-multi' || jaStt?.pick?.id === 'parakeet-tdt-v3', jaStt?.pick?.id);

console.log(`\n${failures === 0 ? 'READINESS PASS ✅' : `READINESS FAIL ❌ (${failures})`}`);
await finish(failures === 0 ? 0 : 1);
