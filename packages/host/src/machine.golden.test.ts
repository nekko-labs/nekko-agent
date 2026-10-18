import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { evaluateReadiness, OFFLINE_STACK_CATALOG } from '@nekko-agent/core';
import type { MachineFacts } from '@nekko-agent/shared';
import { ioregStats, parseNvidiaSmi } from './gpu.js';
import { listedToStats, parseListDevices } from './gpu-vulkan.js';
import { cpuinfoFeatures, gpuBackends, sysctlFeatures } from './readiness.js';
import { macMemoryUsedMB } from './system.js';
import { classifySensor, foldTemps } from './temps.js';

/**
 * The machine probes' parsers and the readiness advisor as the TS host runs
 * them, which the engine daemon's port (crates/nekko-machine, serving
 * `gpu:stats`, `system:stats` and `machine:readiness`) must reproduce as text,
 * key order included. Writes crates/nekko-machine/tests/golden/machine.json and
 * the catalog the daemon embeds (crates/nekko-machine/src/catalog.json); fails
 * if either is stale (rewrite with UPDATE_GOLDEN=1).
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-machine');
const golden = join(crate, 'tests', 'golden', 'machine.json');
const catalogFile = join(crate, 'src', 'catalog.json');

const NVIDIA = [
  'NVIDIA GeForce RTX 5090, 32607, 2400, 29757, 7',
  'NVIDIA GeForce RTX 4090, 24564, 1200, 23000, 0\nNVIDIA RTX A2000, 6138, 100, 5900, [N/A]\n',
  'NVIDIA GeForce GTX 1050, 2048, 300, 1748, \r\nTesla K80, 0, 0, 0, 0\r\n',
  ', 8192, 1, 8191',
  'NVIDIA GeForce RTX 5090, 32607, 2400, 29757, 7, 50',
  'NVIDIA GeForce RTX 4090, 24564, 1200, 23000, 0, [N/A]\nNVIDIA RTX A2000, 6138, 100, 5900, 3, 41.5\n',
  'NVIDIA GeForce GTX 1050, 2048, 300, 1748, 1, ',
  'Broken, abc, 12, 3, 4.5',
  'only, three, cols',
  '',
  'Unknown Error',
];

const IOREG = `+-o AGXAcceleratorG13X  <class AGXAcceleratorG13X, id 0x100000a90, registered, matched, active, busy 0 (144910 ms), retain 104>
    {
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=23611097088,"Tiler Utilization %"=25,"Device Utilization %"=25,"In use system memory"=745570304}
      "model" = "Apple M1 Max"
      "gpu-core-count" = 32
    }
+-o IntelAccelerator  <class IntelAccelerator, id 0x1000004c1, registered>
    {
      "PerformanceStatistics" = {"Alloc system memory"=1073741824,"Device Utilization %"=7}
    }
+-o AGXAcceleratorG16  <class AGXAcceleratorG16>
    {
      "PerformanceStatistics" = {"In use system memory"=2097152}
      "model" = "  Apple M4  "
    }
+-o NoStats  <class NoStats>
    {
      "model" = "Nothing"
    }
`;

const IOREG_CASES: [string, number][] = [
  [IOREG, 65536],
  [IOREG, 16384],
  [IOREG, 0],
  ['+-o Big  <class Big>\n    {\n      "PerformanceStatistics" = {"Alloc system memory"=99999999999999}\n    }\n', 8192],
  ['no accelerators here', 8192],
];

const LIST_DEVICES = [
  'ggml_vulkan: Found 2 Vulkan devices:\nAvailable devices:\n  Vulkan0: GeForce GTX 1050 (2225 MiB, 1924 MiB free)\n  Vulkan1: Intel(R) UHD Graphics 620 (4054 MiB, 3649 MiB free)\nload_backend: loaded CPU backend',
  '  Vulkan0: Intel(R) UHD Graphics 620 (4054 MiB, 3649 MiB free)',
  '  Vulkan0: AMD Radeon(TM) Graphics (2048 MiB, 2000 MiB free)',
  'Vulkan0: Radeon RX Vega 56 (8192 MiB, 8000 MiB free)\r\nVulkan1: Radeon RX Vega 64 (8192 MiB, 9000 MiB free)\r\nVulkan2: AMD Radeon(TM) Vega 8 Graphics (2048 MiB, 2000 MiB free)',
  '  CUDA0: NVIDIA GeForce RTX 5090 (32606 MiB, 30843 MiB free)\n  CUDA1: Zero (0 MiB, 0 MiB free)',
  '  Metal0: Apple M2 (10922 MiB, 10922 MiB free)',
  '',
  'error: unknown argument',
];

const CPUINFO = [
  'processor\t: 0\nflags\t\t: fpu vme AVX avx2 fma f16c sse4_2 avx512f\nbugs\t: none\n',
  'processor\t: 0\nFeatures\t: fp asimd evtstrm aes sve\n',
  'processor\t: 0\nmodel name\t: x\n',
  'flags:',
];

const SYSCTL = [
  'hw.optional.arm.FEAT_FP16: 1\nhw.optional.neon: 1\nhw.optional.AdvSIMD: 1\nhw.optional.armv8_crc32: 0\nhw.optional.floatingpoint: 1\nhw.ncpu: 10\nhw.optional.x86_64: 1 \n',
  '',
];

const BACKENDS: [string | null, string | null][] = [
  ['GPU 0: NVIDIA GeForce RTX 5090 (UUID: GPU-1)', 'Vulkan Instance Version: 1.3\napiVersion = 1.3.280'],
  ['No devices were found', null],
  [null, 'GPU0:\n\tdeviceName = AMD Radeon'],
  [null, null],
  ['', ''],
];

const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               12345.\nAnonymous pages:                         1000000.\nPages purgeable:                           20000.\nPages wired down:                         300000.\nPages occupied by compressor:              50000.\n',
  'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nAnonymous pages:                         100.\nPages purgeable:                           200.\nPages wired down:                         10.\nPages occupied by compressor:              0.\n',
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages:                         1000000.\n',
  '',
];

const SENSORS: [string, string][] = [
  ['k10temp', 'Tctl'], ['coretemp', 'Package id 0'], ['zenpower', 'Tdie'], ['spd5118', ''], ['jc42', ''],
  ['amdgpu', 'edge'], ['amdgpu', 'junction'], ['amdgpu', 'mem'], ['nouveau', ''], ['nvme', 'Composite'], ['acpitz', ''],
  ['', 'PMU tdie1'], ['', 'PMU tp3s'], ['', 'GPU MTR Temp Sensor1'], ['', 'PMU tg0d'], ['', 'NAND CH0 temp'], ['', 'DRAM'],
];

const TEMP_FOLDS: Array<Array<['cpu' | 'memory' | 'gpu', number]>> = [
  [['cpu', 48.4], ['cpu', 61.5], ['memory', 39], ['gpu', 0]],
  [['gpu', 72.5], ['gpu', 151]],
  [['cpu', -5]],
  [],
];

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const FACTS: MachineFacts[] = [
  { os: { platform: 'win32', release: '10.0.26200', arch: 'x64' }, cpuFeatures: null, backends: ['cuda', 'cpu'], devices: [{ name: 'RTX 5090', totalBytes: 32 * GB, freeBytes: 29 * GB }], unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 48 * GB, diskFreeBytes: 500 * GB },
  { os: { platform: 'win32', release: '10.0.26200', arch: 'x64' }, cpuFeatures: ['avx2', 'avx512f'], backends: ['cuda', 'cpu'], devices: [{ name: 'RTX 5090', totalBytes: 32 * GB, freeBytes: 29 * GB }], unified: false, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 48 * GB, diskFreeBytes: 500 * GB },
  { os: { platform: 'darwin', release: '25.6.0', arch: 'arm64' }, cpuFeatures: ['neon'], backends: ['metal', 'cpu'], devices: [{ name: 'Apple M1 Max', totalBytes: 64 * GB, freeBytes: 40 * GB }], unified: true, systemRamTotalBytes: 64 * GB, systemRamFreeBytes: 40 * GB, diskFreeBytes: 300 * GB },
  { os: { platform: 'linux', release: '6.8', arch: 'x64' }, cpuFeatures: ['avx2'], backends: ['cpu'], devices: [], unified: false, systemRamTotalBytes: 16 * GB, systemRamFreeBytes: 10 * GB, diskFreeBytes: 200 * GB },
  { os: { platform: 'linux', release: '6.8', arch: 'x64' }, cpuFeatures: [], backends: ['vulkan', 'cpu'], devices: [{ name: 'GTX 1050', totalBytes: 2225 * MB, freeBytes: 1924 * MB }, { name: 'RX 580', totalBytes: 8 * GB, freeBytes: 7.5 * GB }], unified: false, systemRamTotalBytes: 8 * GB, systemRamFreeBytes: 6 * GB, diskFreeBytes: 3 * GB },
  { os: { platform: 'win32', release: '10.0.19045', arch: 'x64' }, cpuFeatures: null, backends: ['cpu'], devices: [], unified: false, systemRamTotalBytes: 4 * GB, systemRamFreeBytes: 3 * GB, diskFreeBytes: null },
  { os: { platform: 'freebsd', release: '14', arch: 'riscv64' }, cpuFeatures: null, backends: ['cpu'], devices: [], unified: false, systemRamTotalBytes: 2 * GB, systemRamFreeBytes: 1 * GB, diskFreeBytes: 1 * GB },
  { os: { platform: 'win32', release: '10.0.26200', arch: 'x64' }, cpuFeatures: ['avx2'], backends: ['cuda', 'cpu'], devices: [{ name: 'RTX 3060', totalBytes: 12 * GB, freeBytes: 6.3 * GB }], unified: false, systemRamTotalBytes: 32 * GB, systemRamFreeBytes: 7 * GB, diskFreeBytes: 10 * GB },
  { os: { platform: 'darwin', release: '24.0.0', arch: 'arm64' }, cpuFeatures: ['neon'], backends: ['metal', 'cpu'], devices: [{ name: 'Apple M2', totalBytes: 8 * GB, freeBytes: 3 * GB }], unified: true, systemRamTotalBytes: 8 * GB, systemRamFreeBytes: 5.25 * GB, diskFreeBytes: 0 },
];

const LANGUAGES: (string | undefined)[] = [undefined, 'en', 'ja', 'de', 'haw', 'xx'];

it('the machine probes and the readiness advisor match the daemon golden set', () => {
  const out = {
    nvidiaSmi: NVIDIA.map((input) => ({ input, stats: JSON.stringify(parseNvidiaSmi(input)) })),
    ioreg: IOREG_CASES.map(([input, totalMB]) => ({ input, totalMB, stats: JSON.stringify(ioregStats(input, totalMB)) })),
    listDevices: LIST_DEVICES.map((input) => ({ input, stats: JSON.stringify(listedToStats(parseListDevices(input))) })),
    cpuinfo: CPUINFO.map((input) => ({ input, features: cpuinfoFeatures(input) })),
    sysctl: SYSCTL.map((input) => ({ input, features: sysctlFeatures(input) })),
    backends: BACKENDS.map(([smi, vk]) => ({ smi, vk, backends: gpuBackends(smi, vk) })),
    vmStat: VM_STAT.map((input) => ({ input, usedMB: macMemoryUsedMB(input) })),
    sensors: SENSORS.map(([chip, label]) => ({ chip, label, kind: classifySensor(chip, label) })),
    tempFolds: TEMP_FOLDS.map((readings) => ({ readings, temps: foldTemps(readings) })),
    readiness: FACTS.flatMap((facts) =>
      LANGUAGES.map((language) => ({
        facts,
        language: language ?? null,
        report: JSON.stringify(evaluateReadiness(facts, OFFLINE_STACK_CATALOG, { language })),
      })),
    ),
  };
  const catalog = `${JSON.stringify(OFFLINE_STACK_CATALOG, null, 1)}\n`;
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
    writeFileSync(catalogFile, catalog);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
  expect(JSON.parse(readFileSync(catalogFile, 'utf8'))).toEqual(OFFLINE_STACK_CATALOG);
});
