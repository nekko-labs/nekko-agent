import type { GpuAdapter } from '../gpu-adapters.js';
import type { EngineBackend, EngineBuild, EnginePlatform, GpuStats } from '@nekko-agent/shared';

/**
 * Which llama.cpp build this machine should run, and which file that is.
 *
 * llama.cpp publishes one archive per platform and accelerator on every build,
 * named with the build tag (`llama-b10996-bin-win-cuda-13.4-x64.zip`). We match
 * on a pattern rather than a filename so a new build needs no change here, and we
 * order candidates best-first from what the GPU probe actually found rather than
 * from the platform alone: a Windows machine with no NVIDIA card must not be
 * offered the CUDA build as its first choice.
 *
 * Two details in the naming do real damage if ignored, and both are handled here
 * rather than by sorting and hoping. The same accelerator ships for more than one
 * architecture (`-cuda-13.4-arm64` beside `-cuda-13.4-x64`), so the architecture
 * is matched explicitly. And CUDA's runtime libraries ship as a separate archive
 * per toolkit version, so the companion is derived from the archive we chose, not
 * picked independently: a CUDA 13 runtime beside a CUDA 12 build does not start.
 *
 * Nothing is downloaded from this module. It only decides what would be right,
 * which keeps the decision testable without a network.
 */

/**
 * How much faster CUDA is than Vulkan on NVIDIA, as the build picker says it.
 * A rough figure from public llama.cpp results (prompt reading gains more,
 * reply writing less); the benchmark on our own hardware is a TODO in TASKS.md.
 */
export const CUDA_FASTER = 'Roughly 15-20% faster';

const BUILDS: EngineBuild[] = [
  // Windows
  {
    id: 'win-x64-cuda',
    platform: 'win32',
    arch: 'x64',
    backend: 'cuda',
    assetPattern: 'bin-win-cuda',
    requires: `An NVIDIA GPU from the GTX 16 or RTX 20 series on, with driver 580 or newer. ${CUDA_FASTER} than Vulkan on NVIDIA, but a bigger download: it brings the CUDA libraries along.`,
    // The CUDA archive ships without the runtime libraries; they are a separate
    // asset on the same release, and the build will not start without them.
    companionPattern: 'cudart-llama',
  },
  {
    id: 'win-x64-vulkan',
    platform: 'win32',
    arch: 'x64',
    backend: 'vulkan',
    assetPattern: 'bin-win-vulkan',
    requires: `Any GPU with Vulkan drivers (AMD, Intel, or NVIDIA). A small download; on a recent NVIDIA GPU, CUDA is ${CUDA_FASTER.toLowerCase()}.`,
  },
  {
    id: 'win-x64-rocm',
    platform: 'win32',
    arch: 'x64',
    backend: 'hip',
    assetPattern: 'bin-win-rocm',
    requires: 'A recent AMD GPU with ROCm support.',
  },
  {
    id: 'win-x64-cpu',
    platform: 'win32',
    arch: 'x64',
    backend: 'cpu',
    assetPattern: 'bin-win-cpu',
    requires: 'Any x64 processor. Slower, but always works.',
  },
  {
    id: 'win-arm64-cuda',
    platform: 'win32',
    arch: 'arm64',
    backend: 'cuda',
    assetPattern: 'bin-win-cuda',
    requires: 'A Windows on Arm machine with an NVIDIA GPU.',
    companionPattern: 'cudart-llama',
  },
  {
    id: 'win-arm64-cpu',
    platform: 'win32',
    arch: 'arm64',
    backend: 'cpu',
    assetPattern: 'bin-win-cpu',
    requires: 'A Windows on Arm machine.',
  },
  // macOS
  {
    id: 'macos-arm64-metal',
    platform: 'darwin',
    arch: 'arm64',
    backend: 'metal',
    assetPattern: 'bin-macos',
    requires: 'Apple Silicon. Uses the GPU through Metal.',
  },
  // No Intel Mac build: the platform was dropped on 2026-10-13 (see
  // unsupportedPlatformReason in @nekko-agent/shared).
  // Linux
  {
    id: 'linux-x64-cuda',
    platform: 'linux',
    arch: 'x64',
    backend: 'cuda',
    assetPattern: 'bin-ubuntu-cuda',
    requires: `An NVIDIA GPU from the GTX 16 or RTX 20 series on, with driver 580 or newer. ${CUDA_FASTER} than Vulkan on NVIDIA, but a bigger download: it brings the CUDA libraries along.`,
    companionPattern: 'cudart-llama',
  },
  {
    id: 'linux-x64-rocm',
    platform: 'linux',
    arch: 'x64',
    backend: 'hip',
    assetPattern: 'bin-ubuntu-rocm',
    requires: 'A recent AMD GPU with ROCm support.',
  },
  {
    id: 'linux-x64-vulkan',
    platform: 'linux',
    arch: 'x64',
    backend: 'vulkan',
    assetPattern: 'bin-ubuntu-vulkan',
    requires: `A GPU with Vulkan drivers. On a recent NVIDIA GPU, CUDA is ${CUDA_FASTER.toLowerCase()}.`,
  },
  {
    id: 'linux-x64-cpu',
    platform: 'linux',
    arch: 'x64',
    backend: 'cpu',
    assetPattern: 'bin-ubuntu-x64',
    requires: 'Any x64 Linux. Slower, but always works.',
  },
  {
    id: 'linux-arm64-cuda',
    platform: 'linux',
    arch: 'arm64',
    backend: 'cuda',
    assetPattern: 'bin-ubuntu-cuda',
    requires: 'An arm64 Linux machine with an NVIDIA GPU.',
    companionPattern: 'cudart-llama',
  },
  {
    id: 'linux-arm64-vulkan',
    platform: 'linux',
    arch: 'arm64',
    backend: 'vulkan',
    assetPattern: 'bin-ubuntu-vulkan',
    requires: 'An arm64 Linux machine with Vulkan drivers.',
  },
  {
    id: 'linux-arm64-cpu',
    platform: 'linux',
    arch: 'arm64',
    backend: 'cpu',
    assetPattern: 'bin-ubuntu-arm64',
    requires: 'An arm64 Linux machine.',
  },
];

const ARCHIVE_RE = /\.(zip|tar\.gz|tgz)$/i;

/**
 * The builds that could run here, best first.
 *
 * "Best" is the accelerator we have evidence for. An NVIDIA reading from
 * `nvidia-smi` is evidence for CUDA, the fastest backend there, as long as the
 * card and driver can run the CUDA build we download (`CudaSupport`); a card
 * that cannot gets Vulkan first, which runs on it. Apple Silicon is evidence
 * for Metal; a GPU we cannot identify is evidence for Vulkan but not for CUDA.
 * With no evidence at all we lead with CPU, because a slow engine that runs
 * beats a fast one that fails to start.
 */
export function buildsFor(
  platform: EnginePlatform,
  arch: string,
  gpu: GpuStats | null,
  adapters: GpuAdapter[] = [],
  cuda?: CudaSupport,
): EngineBuild[] {
  const candidates = BUILDS.filter((b) => b.platform === platform && b.arch === arch);
  const rank = preferenceOrder(platform, gpu, adapters, cuda);
  return [...candidates]
    .sort((a, b) => rank.indexOf(a.backend) - rank.indexOf(b.backend))
    .map((b) => (b.backend === 'cuda' && cuda?.supported === false && cuda.reason ? { ...b, requires: `${b.requires} ${cuda.reason}` } : b));
}

/**
 * Whether this machine's NVIDIA cards can run llama.cpp's CUDA build. The
 * Windows and Linux x64 builds are CUDA 13, which dropped cards before
 * compute capability 7.5 (Maxwell, Pascal, Volta) and needs driver 580 or
 * newer. Unknown (no reading) is treated as supported, as before this check.
 */
export interface CudaSupport {
  supported: boolean;
  /** Why not, as a sentence for the build picker. */
  reason?: string;
}

export const CUDA_QUERY = ['--query-gpu=compute_cap,driver_version', '--format=csv,noheader'];

/** Read `nvidia-smi --query-gpu=compute_cap,driver_version --format=csv,noheader`. */
export function cudaSupportFrom(stdout: string | null | undefined): CudaSupport | undefined {
  const rows = (stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((c) => c.trim()))
    .filter((cols) => cols.length >= 2)
    .map(([cap, driver]) => ({ cap: Number(cap), driver: Number(driver.split('.')[0]) }))
    .filter((r) => Number.isFinite(r.cap) && Number.isFinite(r.driver) && r.cap > 0 && r.driver > 0);
  if (!rows.length) return undefined;
  if (rows.some((r) => r.cap < 7.5)) {
    return { supported: false, reason: 'This GPU is older than the GTX 16 / RTX 20 series, so the CUDA build cannot run on it; Vulkan can.' };
  }
  if (rows.some((r) => r.driver < 580)) {
    return { supported: false, reason: 'The NVIDIA driver here is older than 580; update it to run the CUDA build.' };
  }
  return { supported: true };
}

function preferenceOrder(platform: EnginePlatform, gpu: GpuStats | null, adapters: GpuAdapter[], cuda?: CudaSupport): EngineBackend[] {
  if (platform === 'darwin') return ['metal', 'cpu', 'vulkan', 'cuda', 'hip'];
  if (gpu?.source === 'nvidia-smi' && gpu.devices.length > 0) {
    return cuda?.supported === false ? ['vulkan', 'cuda', 'cpu', 'hip', 'metal'] : ['cuda', 'vulkan', 'cpu', 'hip', 'metal'];
  }
  // A GPU we know nothing about: Vulkan is the portable accelerated path, and
  // claiming CUDA without an NVIDIA reading would be a guess.
  if (gpu && gpu.devices.length > 0) return ['vulkan', 'cpu', 'cuda', 'hip', 'metal'];
  // An AMD or Intel GPU has no stats tool we read, so the OS's own adapter list
  // is the evidence; without it these machines were offered the CPU build.
  if (adapters.some((a) => a.vendor !== 'other')) return ['vulkan', 'cpu', 'cuda', 'hip', 'metal'];
  return ['cpu', 'vulkan', 'cuda', 'hip', 'metal'];
}

/**
 * The CUDA build, when this machine has an NVIDIA GPU (by `nvidia-smi`) that
 * can run it and is on a managed build of something else: a Vulkan or CPU
 * install chosen by hand, or made before CUDA was preferred.
 */
export function cudaUpgrade(
  platform: EnginePlatform,
  arch: string,
  gpu: GpuStats | null,
  installed: EngineBackend | undefined,
  cuda?: CudaSupport,
): EngineBuild | undefined {
  if (!installed || installed === 'cuda' || installed === 'metal') return undefined;
  if (gpu?.source !== 'nvidia-smi' || gpu.devices.length === 0) return undefined;
  if (cuda?.supported === false) return undefined;
  return BUILDS.find((b) => b.platform === platform && b.arch === arch && b.backend === 'cuda');
}

/** The build we would install if the user just says yes. */
export function recommendedBuild(
  platform: EnginePlatform,
  arch: string,
  gpu: GpuStats | null,
  adapters: GpuAdapter[] = [],
  cuda?: CudaSupport,
): EngineBuild | undefined {
  return buildsFor(platform, arch, gpu, adapters, cuda)[0];
}

/**
 * Pick a release asset for a build.
 *
 * The architecture is required rather than assumed, because the same accelerator
 * ships for both and an arm64 archive on an x64 machine downloads several hundred
 * megabytes of something that cannot run. Where a build exists for several CUDA
 * toolkits the highest version wins, compared numerically: sorting these as
 * strings puts `cuda-9` above `cuda-13`.
 */
export function matchAsset(build: EngineBuild, assetNames: string[]): string | undefined {
  const hits = assetNames.filter(
    (n) => n.includes(build.assetPattern) && ARCHIVE_RE.test(n) && archMatches(n, build.arch) && !isCompanion(n),
  );
  return hits.sort((a, b) => toolkitVersion(a) - toolkitVersion(b) || a.localeCompare(b)).at(-1);
}

/**
 * The runtime-library archive that belongs with a chosen asset.
 *
 * Derived from that asset rather than matched independently, so the toolkit
 * version and architecture cannot drift apart from the build they are meant to
 * support. Returns undefined when the build needs no companion.
 */
export function matchCompanion(
  build: EngineBuild,
  assetName: string,
  assetNames: string[],
): string | undefined {
  if (!build.companionPattern) return undefined;
  // The platform is part of the key, not just the toolkit and arch: every
  // release carries an Ubuntu runtime beside the Windows one with the same
  // `cuda-13.4-x64` tail (`cudart-llama-bNNNN-bin-ubuntu-cuda-13.4-x64.tar.gz`).
  // Matching on that tail alone gave Windows the Linux `.so` files; the CUDA
  // backend then found no GPU and every model ran on the CPU, silently.
  // `llama-b10996-bin-win-cuda-13.4-x64` -> `bin-win-cuda-13.4-x64`.
  const variant = assetName.replace(ARCHIVE_RE, '').match(/(bin-[a-z]+-cuda-[\d.]+-\w+)$/)?.[1];
  if (!variant) return undefined;
  return assetNames.find(
    (n) =>
      n.startsWith(build.companionPattern as string) &&
      ARCHIVE_RE.test(n) &&
      n.replace(ARCHIVE_RE, '').endsWith(`-${variant}`),
  );
}

/** Every build we know about, for the "choose it yourself" list. */
export function allBuilds(): EngineBuild[] {
  return BUILDS;
}

/**
 * Whether a release carries the binaries at all.
 *
 * llama.cpp's `releases/latest` is a marker release holding one text file that
 * names the current nightly; the archives live on the `bNNNN` tags. So the newest
 * release is not the newest *build*, and asking for "latest" gets an empty
 * answer. The caller scans recent releases and keeps the first that passes this.
 */
export function hasBinaries(assetNames: string[]): boolean {
  return assetNames.some((n) => /^llama-b\d+-bin-/.test(n) && ARCHIVE_RE.test(n));
}

/** `-x64.zip` / `-arm64.tar.gz`, as a suffix rather than as a substring. */
function archMatches(name: string, arch: string): boolean {
  const base = name.replace(ARCHIVE_RE, '');
  // macOS and Linux CPU archives end in the arch with nothing after it; Windows
  // and the accelerated builds put the arch last too, which is what makes a
  // suffix test enough.
  return base.endsWith(`-${arch}`);
}

function isCompanion(name: string): boolean {
  return name.startsWith('cudart-');
}

/** The CUDA toolkit version embedded in an asset name, as a sortable number. */
function toolkitVersion(name: string): number {
  const m = name.match(/cuda-(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : 0;
}
