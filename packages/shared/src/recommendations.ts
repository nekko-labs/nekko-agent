/**
 * The hardware profile and the model recommendations made against it, as the
 * daemon answers `machine:profile` and `machine:recommendations`
 * (`crates/nekko-machine/src/profile.rs` and `recommend.rs`).
 *
 * A recommendation is made before anything is downloaded, from a feed built
 * offline (`scripts/model-feed.mjs`) and shipped with the app: the client
 * never searches or scrapes to make one. Every speed says where it came from,
 * and a GPU the feed does not know gets no speed rather than a guess.
 */

/** One GPU as the probe found it. On Apple Silicon `vramBytes` is the shared pool. */
export interface ProfileGpu {
  name: string;
  vramBytes: number;
  /** GPU core count where the OS reports one (Apple Silicon). */
  cores?: number;
}

/** What this machine has: totals, not what is free right now. */
export interface HardwareProfile {
  format: 1;
  /** When the probe ran, ms since the epoch. A saved profile is reused for a week. */
  probedAt: number;
  platform: string;
  arch: string;
  release: string;
  cpu: { model?: string; cores: number };
  ramBytes: number;
  /** One memory pool for CPU and GPU (Apple Silicon). */
  unified: boolean;
  gpus: ProfileGpu[];
  /** Compute backends the machine can run: `cuda`, `vulkan`, `metal`, `cpu`. */
  backends: string[];
  /** The engine build installed, when there is one. */
  engine: { backend: string; version?: string } | null;
  /** Free space where models are kept, read fresh on every answer. */
  diskFreeBytes?: number;
}

/** The task a pick is for. */
export type RecommendationTask = 'chat' | 'code' | 'router' | 'embedding' | 'vision';

/** Where the model runs: a discrete GPU, Apple Silicon's shared pool, or system RAM. */
export type RecommendationPlacement = 'gpu' | 'unified' | 'cpu';

/** `fits` leaves room; `tight` fits with little to spare; `tooBig` does not fit. */
export type RecommendationFit = 'fits' | 'tight' | 'tooBig';

/**
 * - `measuredHere`: the median of this machine's own recent replies with this file.
 * - `measured`: measured on this class of hardware with this exact file.
 * - `estimated`: from memory bandwidth, with this backend's measured efficiency.
 * - `estimatedBorrowed`: from memory bandwidth, with an efficiency measured on
 *   another backend; the roughest figure, and the UI should say so.
 */
export type SpeedBasis = 'measuredHere' | 'measured' | 'estimated' | 'estimatedBorrowed';

export interface RecommendedOption {
  modelId: string;
  name: string;
  owner: string;
  /** Hugging Face repo, `owner/name`. */
  repo: string;
  quant: string;
  /** The label `engineDownloadModel(repo, label)` takes: the catalog's, without prefixes such as `UD-`. */
  downloadLabel: string;
  /** Every file to download: the weights (all shards) and the image projector when the task needs one. */
  files: string[];
  downloadBytes: number;
  /** Weights + KV cache at `contextTokens` + compute buffers. */
  memoryBytes: number;
  /** Budget left after loading it. */
  headroomBytes: number;
  contextTokens: number;
  placement: RecommendationPlacement;
  fit: RecommendationFit;
  /** Decode tokens/s at the start of a conversation; absent where unknown or not what the task waits on. */
  speed: { tokensPerSecond: number; basis: SpeedBasis; /** Replies a `measuredHere` figure is the median of. */ samples?: number } | null;
  /** Slower than the task's minimum. */
  tooSlow: boolean;
}

export interface TaskRecommendation {
  task: RecommendationTask;
  label: string;
  minTokensPerSecond: number | null;
  pick: RecommendedOption | null;
  /** Nothing that fits is fast enough; `pick` is the fastest that fits. */
  belowTargetSpeed: boolean;
  /** Each candidate at the quant it would be offered at, best first. */
  options: RecommendedOption[];
}

export interface Recommendations {
  feedVersion: string;
  hardware: {
    /** The device the budget is measured against; `null` on a CPU-only machine. */
    device: string | null;
    /** The feed's hardware row; `null` for a GPU it does not list. */
    classId: string | null;
    bandwidthGBps: number | null;
    backend: string;
  };
  /** What a model may use: the roomiest GPU less the display's share, the GPU share of unified memory, or RAM less the OS's. */
  budget: { bytes: number; placement: RecommendationPlacement };
  tasks: TaskRecommendation[];
}
