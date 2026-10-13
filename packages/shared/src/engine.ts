/**
 * The Nekko engine: the model server Nekko Agent runs itself.
 *
 * Everything else in `runtimes.ts` describes a server somebody else installed.
 * This file describes the one we own, which needs three things the others do not:
 * a way to acquire the engine binary, a way to acquire models, and a server
 * configuration of its own (port, binding, key) because there is no other app to
 * configure it in.
 *
 * The engine is `llama.cpp`'s `llama-server`, one child process per loaded model,
 * behind a router that presents them all on one OpenAI-compatible address. That
 * shape is what lets several models be resident at once, which is the difference
 * between a wrapper and a model server.
 */

import type { FitVerdict, KvCacheDtype } from './capacity.js';
import { ENGINE_PORT_DEFAULT } from './models.js';
import type { ResidentModel } from './runtimes.js';

/** Where an engine binary came from. */
export type EngineSource = 'managed' | 'external';

/**
 * The platforms llama.cpp publishes builds for. A string union rather than
 * `NodeJS.Platform` because this package is shared with the renderer, which has
 * no Node types and must not grow a dependency on them.
 */
export type EnginePlatform = 'win32' | 'darwin' | 'linux';

/** The acceleration backend a build was compiled for. */
export type EngineBackend = 'cuda' | 'metal' | 'vulkan' | 'hip' | 'cpu';

export const ENGINE_BACKEND_LABELS: Record<EngineBackend, string> = {
  cuda: 'NVIDIA (CUDA)',
  metal: 'Apple (Metal)',
  vulkan: 'Vulkan',
  hip: 'AMD (ROCm/HIP)',
  cpu: 'CPU only',
};

/**
 * One downloadable llama.cpp build.
 *
 * `assetPattern` is matched against a release's asset names rather than being a
 * fixed filename, because llama.cpp's asset names carry the build number
 * (`llama-b7021-bin-win-cuda-x64.zip`) and pinning a filename would mean pinning
 * a build forever.
 */
export interface EngineBuild {
  id: string;
  platform: EnginePlatform;
  arch: string;
  backend: EngineBackend;
  /** Matched against release asset names, most specific first. */
  assetPattern: string;
  /** Human sentence for the picker: what hardware this build is for. */
  requires: string;
  /** Extra runtime libraries this build needs alongside the main archive. */
  companionPattern?: string;
}

/** What we know about the engine on this machine right now. */
export interface EngineInstall {
  /** Absolute path to `llama-server`, when one is usable. */
  binPath?: string;
  source?: EngineSource;
  backend?: EngineBackend;
  /** llama.cpp build tag, e.g. `b7021`. */
  version?: string;
  installedAt?: number;
  /** Why no engine is usable, when `binPath` is absent. */
  reason?: string;
  /**
   * The engine is installed and starts, but not the way it should: a managed
   * GPU build missing the libraries its backend needs, so every model runs on
   * the CPU without any error. `repairBuildId` reinstalls that build cleanly.
   */
  problem?: { message: string; repairBuildId: string };
  /**
   * A faster build this machine can run than the managed one installed: CUDA
   * on an NVIDIA GPU that is running the Vulkan build. Vulkan is the default
   * there because it is a 30 MB download against CUDA's 550 MB; this is the
   * opt-in step up, never taken without the user asking.
   */
  upgrade?: { buildId: string; message: string };
  /** Builds offered for this machine, best first. */
  available: EngineBuild[];
  /** The build we would install if asked, from the hardware probe. */
  recommended?: EngineBuild;
}

export interface EngineInstallPreview {
  runtime: 'llama' | 'diffusion' | 'mlx';
  version: string;
  build: EngineBuild;
  sizeBytes: number;
  files: Array<{ name: string; sizeBytes: number }>;
}

export interface ImageGenerationRequest {
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
}

/** The companion files a diffusion model needs: text encoders, a VAE, an LLM encoder. */
export type ImageCompanionRole = 'clip_l' | 'clip_g' | 't5xxl' | 'vae' | 'llm' | 'taesd';

/** What an image model's companion set has on disk, and what fetching the rest costs. */
export interface ImageCompanionStatus {
  setId: string;
  label: string;
  files: Array<{
    role: ImageCompanionRole;
    /** `repo/path` on Hugging Face. */
    source: string;
    bytes: number;
    /** Needs a Hugging Face token with the license accepted. */
    gated: boolean;
    /** Where it is on disk, when it is. */
    path?: string;
    /** A gated VAE is standing in (or, without a token, will) with its small ungated approximation. */
    usingFallback: boolean;
  }>;
  ready: boolean;
  missingBytes: number;
  /** Steps and CFG scale the family is tuned for. */
  defaults: { steps: number; cfgScale: number };
}

export interface ImageGenerationResult {
  created: number;
  data: Array<{ b64_json: string }>;
}

/**
 * The engine's own server configuration, which for every other runtime lives in
 * that runtime's app. Defaults are deliberately the safe ones: loopback only, no
 * key needed, nothing started until asked.
 */
export interface EngineSettings {
  port: number;
  /** `local` binds 127.0.0.1; `lan` binds 0.0.0.0 and is a deliberate act. */
  bind: 'local' | 'lan';
  /** Required as a Bearer token when set. Empty means no auth, which is fine on loopback. */
  apiKey?: string;
  /** Allowed browser origins. `*` is permitted but never the default. */
  corsOrigins?: string;
  /** Start the router when Nekko Agent starts. */
  autoStart: boolean;
  /**
   * Model ids to load right after the router binds, in order.
   *
   * `autoStart` brings the endpoint up; this is which models are resident when
   * it does. Each loads with its saved preset (or the planner's default), and a
   * failure is recorded on the model rather than blocking the rest.
   */
  autoload?: string[];
  /** Load a model on first request rather than making the user load it first. */
  jitLoad: boolean;
  /** Evict a model after this many idle seconds. 0 keeps it resident. */
  idleTtlSeconds: number;
  /** How many models may be resident at once. */
  maxLoaded: number;
  /** Where GGUF files live. Defaults to `<dataDir>/models`. */
  modelsDir?: string;
  /**
   * Extra folders to look in, beyond the one downloads land in.
   *
   * A list rather than a second path because the models on a machine are
   * usually spread over several apps' folders at once, and because a folder
   * someone stops using should be switchable off without being retyped later.
   */
  modelFolders?: ModelFolder[];
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  port: ENGINE_PORT_DEFAULT,
  bind: 'local',
  autoStart: false,
  jitLoad: true,
  idleTtlSeconds: 900,
  maxLoaded: 2,
};

/** The engine's base URL for a given configuration. */
export function engineBaseUrl(settings: Pick<EngineSettings, 'port'>): string {
  return `http://127.0.0.1:${settings.port}/v1`;
}

/**
 * A model on its way into memory.
 *
 * Loads are serialized, so one that is not first in line sits at `queued`
 * until the one ahead of it lands. `progress` is measured rather than
 * estimated: the drop in free VRAM against the share of the file headed to
 * the GPU. Absent means the load leaves no signal we can read (a CPU load,
 * or no GPU probe), which the bar shows as indeterminate rather than fake.
 */
export interface LoadingModel {
  id: string;
  phase: 'queued' | 'loading';
  startedAt: number;
  progress?: number;
}

/** Everything the engine card needs in one read. */
export interface EngineStatus {
  install: EngineInstall;
  diffusionInstall?: EngineInstall;
  /** MLX (Apple Silicon only); `available` is empty on any other machine. */
  mlxInstall?: EngineInstall;
  running: boolean;
  startedAt?: number;
  resident: ResidentModel[];
  /** Models being loaded right now, in queue order. */
  loading?: LoadingModel[];
  /** Recent router and child-process output, newest last. */
  log: string[];
  port: number;
  settings: EngineSettings;
  /** What this machine has to run models in, for "will it fit" guidance. */
  memory?: EngineMemory;
}

/**
 * The memory a downloaded model would be loaded into.
 *
 * `budgetBytes` is the pool's *total*, not the free figure: the question it
 * answers is "can this file ever be served here", not "can it be served while
 * everything else stays open", which the fit planner answers per-load.
 */
export interface EngineMemory {
  budgetBytes: number;
  /** What the number is, so the UI can name it honestly. */
  kind: 'vram' | 'unified' | 'ram';
}

/**
 * Whether a download of `sizeBytes` can run in `budgetBytes` of memory.
 *
 * Rough on purpose and marked as such: the file size plus ~20% stands in for
 * the true working set (weights + KV + runtime), which the GGUF planner only
 * computes exactly once the file is on disk. Unknown inputs return 'unknown'
 * rather than a guess wearing a verdict's clothes.
 */
export function downloadFitVerdict(
  sizeBytes: number | undefined,
  budgetBytes: number | undefined,
): FitVerdict {
  if (!sizeBytes || !budgetBytes) return 'unknown';
  const need = sizeBytes * 1.2;
  if (need <= budgetBytes * 0.55) return 'fits';
  if (need <= budgetBytes * 0.85) return 'tight';
  return 'wont-load';
}

/**
 * The simple surface's only control: how much of this machine the model may use.
 *
 * It is a fraction rather than three named presets because it feeds the planner
 * as a number, and because the honest answer to "will 70% work" depends on the
 * machine, not on a label.
 */
export interface MachineBudget {
  /** 0..1 of free memory the model may occupy. */
  fraction: number;
}

export const BUDGET_PRESETS: Array<{ id: string; label: string; fraction: number; hint: string }> = [
  { id: 'gentle', label: 'Leave my machine usable', fraction: 0.5, hint: 'Other apps stay responsive.' },
  { id: 'balanced', label: 'Balanced', fraction: 0.75, hint: 'Most of the memory, some left over.' },
  { id: 'full', label: 'Everything it has', fraction: 0.92, hint: 'Fastest, expect stutter elsewhere.' },
];

/* ------------------------------------------------------------------ catalog */

/** One quantization of one model: the thing actually downloaded. */
export interface CatalogQuant {
  /** e.g. `Q4_K_M`. */
  label: string;
  /** Repo-relative file name. */
  file: string;
  sizeBytes?: number;
  /** Extra files the model needs (a multimodal projector, split shards). */
  extraFiles?: string[];
  /** Short note for the picker, e.g. "best balance of size and quality". */
  note?: string;
  /**
   * `mlx`: the whole repo is one model folder (an MLX checkpoint), and
   * `file` plus `extraFiles` are every file it needs. Absent means GGUF.
   */
  format?: 'mlx';
}

/** A model as offered for download, before it exists on disk. */
export interface CatalogModel {
  /** Stable id: `<owner>/<repo>` on Hugging Face. */
  id: string;
  name: string;
  /** Publisher handle, for the "who made this" line. */
  owner: string;
  parameterSize?: string;
  /** One line about what this model is for. */
  summary?: string;
  /** Curated capability tags: `chat`, `code`, `reasoning`, `vision`, `embedding`, `tools`. */
  tags: string[];
  quants: CatalogQuant[];
  downloads?: number;
  /** Set on curated entries so the starter list can be shown before any search. */
  curated?: boolean;
  /** The curated default pick: the one to suggest when someone asks "which one". */
  recommended?: boolean;
  /** License id when the repo declares one, so a gated model can say so. */
  license?: string;
  /** The repo needs accepted terms or a token; we surface it rather than failing mid-download. */
  gated?: boolean;
  /** Hearts on Hugging Face, next to the download count. */
  likes?: number;
  /** Last commit to the repo, for the "is this maintained" question. */
  updatedAt?: number;
  createdAt?: number;
  /** The task the publisher declared, e.g. `text-generation`. */
  pipelineTag?: string;
  /** The weights this GGUF was converted from, when the repo says so. */
  baseModel?: string;
  /** Every tag the repo carries, not just the capability chips. */
  hfTags?: string[];
}

/**
 * A catalog model with the things only its own page has room for.
 *
 * The extra call this needs is the model card itself, which is a README on
 * Hugging Face and can run to thousands of words. It is fetched when a model is
 * opened rather than with the list, so browsing stays one request per search
 * instead of one per result.
 */
export interface CatalogModelDetail extends CatalogModel {
  /** The model card, as markdown, with its YAML front matter stripped. */
  readme?: string;
  /** Set when the card could not be read, so the page can say why. */
  readmeError?: string;
  /** Other repos publishing GGUF builds of the same weights. */
  related?: CatalogModel[];
}

export type DownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

/** One file being fetched, whether it is an engine build or a model. */
export interface DownloadJob {
  id: string;
  kind: 'model' | 'engine';
  /** What the UI calls it. */
  label: string;
  /** Model id for a model job; build id for an engine job. */
  target: string;
  /** Where the file lands, so a completion hook can find it without reparsing the id. */
  dest?: string;
  /**
   * Jobs that make up one acquisition (a model's weights, its later shards,
   * projector and tokenizer files) share a group id, so the UI can show them as
   * one download with a row per file. Absent means the job stands alone.
   */
  group?: string;
  /** What the UI calls the whole group, e.g. `Qwen3 4B · Q4_K_M`. */
  groupLabel?: string;
  /** The file this job fetches (repo-relative path or basename), for the per-file row. */
  file?: string;
  /** A role the caller already knows (an image model's "VAE"); otherwise the UI infers it from `file`. */
  role?: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes?: number;
  /** Bytes per second over the last window, for the ETA. */
  bytesPerSecond?: number;
  startedAt: number;
  finishedAt?: number;
  message?: string;
}

/** What a local model file is for. This decides whether llama-server can run it at all. */
export type ModelModality = 'chat' | 'vision' | 'embedding' | 'audio' | 'image' | 'draft' | 'unknown';

/**
 * Where the planner expects a model to live under its current settings.
 *
 * `full` = every layer fits in VRAM; `partial` = some layers spill to CPU/RAM;
 * `cpu` = this machine has no GPU to offload to; `wont` = it does not fit
 * anywhere; `unknown` = the file does not publish enough geometry to tell.
 * The library row uses it to flag the models that will not run at full speed.
 */
export type GpuFit = 'full' | 'partial' | 'cpu' | 'wont' | 'unknown';

/** Short labels for the modality chips in the library. */
export const MODALITY_LABELS: Record<ModelModality, string> = {
  chat: 'chat',
  vision: 'vision',
  embedding: 'embeddings',
  audio: 'audio',
  image: 'image gen',
  draft: 'draft head',
  unknown: 'unreadable',
};

/**
 * Image-generation weights (stable-diffusion.cpp / sd.cpp territory). These are
 * GGUF files, but the graph inside is a diffusion model: llama-server cannot
 * serve them no matter which flags accompany the file.
 */
const IMAGE_GEN_ARCHS =
  /^(sd\d?|sdxl|sd-?turbo|stable-?diffusion.*|flux.*|wuerstchen|pixart.*|ltxv.*|hidream.*|chroma.*|qwen-?image.*|z-?image.*|ovis-?image.*|wan\d.*|hunyuan.*(image|video).*|cogvideo.*)/i;

/** Speech-recognition and audio weights; these need a speech engine, not an LLM server. */
const AUDIO_ARCHS = /^(whisper.*|parakeet.*|moonshine.*|sense-?voice.*|wav2vec.*|hubert.*|seamless.*|zipformer.*)/i;

/**
 * Speculative-decoding draft heads. They only run attached to a full model
 * (`--model-draft`), never as the served model itself.
 */
const DRAFT_ARCHS = /draft|eagle|medusa|lookahead|speculative/i;

/** Embedding encoders. Loadable (`--embedding`), but they answer /v1/embeddings, not chat. */
const EMBEDDING_ARCHS = /bert|embed|bge|gte-?|roberta|xlm-?roberta|nomic|jina-?v\d/i;

/**
 * Architectures llama.cpp can serve with a multimodal projector attached.
 * A sibling `mmproj-*.gguf` is the stronger signal and is checked separately;
 * this set catches vision models whose projector was never downloaded, so they
 * can be labelled and warned about before anyone tries to run one.
 */
const VISION_ARCHS =
  /llava|qwen\d*vl|gemma[3-9]|gemma3n|mllama|llama-?\d?.*vision|pixtral|moondream|minicpm-?v|internvl|deepseek.*(ocr|vl)|smolvlm|paligemma|idefics|phi-?\d*.*vision|kimi-?vl|glm-?\d*v|ovis|voxtral|ultravox|muse-?glimmer|nemotron.*omni/i;

/**
 * What a model file is for, from the GGUF architecture, a projector sitting
 * beside it, and (when the header could not be read) the file's own name.
 *
 * `hasProjector` is evidence rather than the question: a Gemma 4 without its
 * mmproj is still a vision model, it is just one whose eyes were never
 * downloaded, and classifying it `vision` is what lets the UI say so.
 */
export function modelModality(model: {
  architecture?: string;
  name?: string;
  hasProjector?: boolean;
  readable?: boolean;
}): ModelModality {
  const arch = model.architecture ?? '';
  if (arch) {
    if (IMAGE_GEN_ARCHS.test(arch)) return 'image';
    if (AUDIO_ARCHS.test(arch)) return 'audio';
    if (DRAFT_ARCHS.test(arch)) return 'draft';
    if (EMBEDDING_ARCHS.test(arch)) return 'embedding';
    if (VISION_ARCHS.test(arch)) return 'vision';
  }
  if (!arch && model.readable !== false) {
    // A name is a file name; capping it keeps these patterns linear however
    // long a string arrives.
    const name = (model.name ?? '').slice(0, 256);
    if (/(?:^|[ /_-])(?:sd[123](?:[. _-]|$)|sdxl|flux[. _-]|stable[-_ ]diffusion|qwen[-_ ]image|z[-_ ]image|hidream|chroma|text-to-image|image-to-image)/i.test(name)) return 'image';
    if (/embedding|feature-extraction|(?:^|[ /_-])bge[-_]/i.test(name)) return 'embedding';
    if (/whisper|parakeet|automatic-speech-recognition/i.test(name)) return 'audio';
    if (VISION_ARCHS.test(name) || /image-text-to-text|\bvision\b/i.test(name)) return 'vision';
  }
  if (model.hasProjector) return 'vision';
  if (model.readable === false) {
    // An unreadable header means we cannot trust the name either, but the
    // common case is an old GGML whisper file renamed `.gguf`, which is at
    // least worth labelling honestly rather than as a chat model.
    if (/whisper|parakeet|moonshine|sense-?voice/i.test(model.name ?? '')) return 'audio';
    return 'unknown';
  }
  return 'chat';
}

/**
 * Why a model cannot be loaded here, or undefined when it can.
 *
 * The sentence doubles as the row's explanation and the load failure, so it
 * names what the file actually is and where it does run rather than just
 * refusing. `chat`, `vision` and `embedding` models are all servable;
 * everything else llama.cpp cannot run, however the flags are set.
 */
export function unsupportedLoadReason(model: {
  modality?: ModelModality;
  name?: string;
  readable?: boolean;
  format?: 'gguf' | 'mlx';
  mlxRunnable?: boolean;
}): string | undefined {
  const name = model.name ?? 'This model';
  if (model.format === 'mlx') {
    return model.mlxRunnable ? undefined : `${name} is an MLX model, which runs on Apple Silicon Macs only.`;
  }
  switch (model.modality ?? modelModality(model)) {
    case 'image':
      return `${name} is an image-generation model. The llama.cpp engine cannot serve it; it runs in stable-diffusion.cpp (the runtime LM Studio uses for image models).`;
    case 'audio':
      return `${name} is a speech-recognition model, which llama.cpp cannot serve. It needs a speech engine such as whisper.cpp or parakeet.cpp.`;
    case 'draft':
      return `${name} is a speculative-decoding draft model. It can only run attached to its full model, not on its own.`;
    case 'unknown':
      return `${name} is not a readable GGUF${model.readable === false ? ' (it may be an older GGML-format file)' : ''}, so the engine cannot serve it.`;
    default:
      return undefined;
  }
}

/** A model on disk (a GGUF file, or an MLX model folder), with whatever it told us. */
export interface LocalModel {
  /** `<owner>/<repo>/<file>` for a downloaded model; the file name for an imported one. */
  id: string;
  name: string;
  /** The GGUF file, or for an MLX model its folder. */
  path: string;
  /** Absent means GGUF, which every row was before MLX. */
  format?: 'gguf' | 'mlx';
  /** For an MLX model: whether this machine can run it (Apple Silicon). */
  mlxRunnable?: boolean;
  sizeBytes: number;
  quantization?: string;
  parameterSize?: string;
  architecture?: string;
  /** What the file is for, classified from the architecture and its companions. */
  modality?: ModelModality;
  /** The file parsed as GGUF v2/v3; false means the header would not read at all. */
  readable?: boolean;
  /** A vision model's projector was found beside the weights or in the companions dir. */
  hasProjector?: boolean;
  /**
   * The last load attempt's reason for failing, kept until a load succeeds.
   * Runtime state, filled in by the server rather than stored in the index.
   */
  lastLoadError?: string;
  layers?: number;
  kvHeads?: number;
  headDim?: number;
  maxContext?: number;
  /**
   * The GGUF embeds `tokenizer.chat_template`, so llama.cpp can prompt it with
   * no sidecar. Absent templates fall back to a template file beside the model.
   */
  hasChatTemplate?: boolean;
  /** Set when the file came from the catalog rather than an import. */
  sourceRepo?: string;
  /** The folder this file was found in, or `primary` for our own models dir. */
  folderId?: string;
  /** The app whose layout that folder belongs to, when we recognised one. */
  folderProvider?: ModelFolderProviderId;
  /** False for a folder we only read: deleting there would break another app. */
  managed?: boolean;
  addedAt: number;
  /** Per-model saved load settings, applied when it is loaded. */
  preset?: EngineLoadPreset;
}

/**
 * Saved load settings for one model.
 *
 * Kept separate from `LoadParams` because this is the persisted form: every field
 * optional, absent meaning "decide from the budget" rather than "use zero".
 */
export interface EngineLoadPreset {
  contextTokens?: number;
  gpuLayers?: number;
  kvCacheDtype?: KvCacheDtype;
  batchSize?: number;
  ubatchSize?: number;
  threads?: number;
  parallelSlots?: number;
  flashAttention?: boolean;
  mmap?: boolean;
  mlock?: boolean;
  ropeFreqBase?: number;
  ropeFreqScale?: number;
  seed?: number;
  speculative?: boolean;
  draftModelId?: string;
  ttlSeconds?: number;
  /** The simple slider's position, kept so the two surfaces stay one state. */
  budgetFraction?: number;
  diffusion?: { clip_l?: string; clip_g?: string; t5xxl?: string; vae?: string; llm?: string; taesd?: string; standalone?: boolean; offloadToCpu?: boolean; clipOnCpu?: boolean };
}

/* ------------------------------------------------------- model folders */

/**
 * The apps whose model folders we know how to find.
 *
 * A GGUF on this machine is a GGUF whoever downloaded it, so a model already
 * pulled through Ollama or LM Studio should not have to be downloaded a second
 * time to be run here. Each id is a layout we know the default path of and, for
 * Ollama, a naming scheme we know how to read.
 */
export type ModelFolderProviderId =
  | 'nekko'
  | 'ollama'
  | 'lmstudio'
  | 'jan'
  | 'gpt4all'
  | 'llamacpp'
  | 'huggingface'
  | 'koboldcpp'
  | 'textgenwebui'
  | 'localai'
  | 'bionic'
  | 'vllm';

export interface ModelFolderProvider {
  label: string;
  /** One line for the folder list: what put models here. */
  hint: string;
}

export const MODEL_FOLDER_PROVIDERS: Record<ModelFolderProviderId, ModelFolderProvider> = {
  nekko: { label: 'Nekko Agent', hint: 'Models downloaded here.' },
  ollama: { label: 'Ollama', hint: 'Ollama stores models as hashed blobs; names come from its manifests.' },
  lmstudio: { label: 'LM Studio', hint: 'LM Studio keeps GGUF files under publisher/repo.' },
  jan: { label: 'Jan', hint: 'Jan keeps one folder per model.' },
  gpt4all: { label: 'GPT4All', hint: 'GPT4All keeps every GGUF in one folder.' },
  llamacpp: { label: 'llama.cpp', hint: "llama.cpp's own models folder." },
  huggingface: { label: 'Hugging Face cache', hint: 'Anything pulled with huggingface-cli or the Python libraries.' },
  koboldcpp: { label: 'KoboldCpp', hint: 'KoboldCpp model folder.' },
  textgenwebui: { label: 'Text generation web UI', hint: "oobabooga's models folder." },
  localai: { label: 'LocalAI', hint: 'LocalAI model folder.' },
  bionic: { label: 'Bionic', hint: 'Bionic GPT model folder.' },
  vllm: { label: 'vLLM', hint: 'vLLM serves from the Hugging Face cache by default.' },
};

/** Where the library looks for models, beyond the folder we download into. */
export interface ModelFolder {
  /** Stable id, also the prefix of every model id found here. */
  id: string;
  path: string;
  /** Set when this folder matches a layout we know. */
  provider?: ModelFolderProviderId;
  /** Off without being forgotten: kept in the list, skipped on a scan. */
  enabled: boolean;
  /** The user typed this one in rather than us finding it. */
  custom?: boolean;
}

/**
 * A folder as the settings page shows it: what we have configured, plus what the
 * last scan actually found there.
 *
 * `primary` is the one folder downloads land in. It is always present, always
 * enabled, and cannot be removed, which is why it is a flag rather than another
 * row the user could delete out from under a download.
 */
export interface ModelFolderStatus extends ModelFolder {
  primary?: boolean;
  exists: boolean;
  modelCount: number;
  sizeBytes: number;
  /** Why nothing was read, when something went wrong rather than nothing being there. */
  error?: string;
}

/** A known folder we found on this machine that is not in the list yet. */
export interface ModelFolderSuggestion {
  provider: ModelFolderProviderId;
  path: string;
  modelCount: number;
  sizeBytes: number;
}

export interface ModelFolderReport {
  folders: ModelFolderStatus[];
  /** Known layouts present on disk that nobody has added yet. */
  suggestions: ModelFolderSuggestion[];
}

/**
 * The context a model gets when nothing asked for a size: its trained maximum,
 * capped at 64k tokens.
 *
 * Left to itself llama.cpp takes the trained context for every parallel slot
 * (4 by default), so a 262k-token model asked for a million-token KV cache and
 * `--fit` filled the GPU to within 1 GiB of full. The first flash-attention
 * kernel then sometimes could not be loaded ("CUDA error: shared object
 * initialization failed") and the model server died on its first request; the
 * oversized cache also made loads take 10 to 25 s. 64k is more than an agent
 * turn needs, and the drawer can always ask for more.
 */
export const ENGINE_DEFAULT_CONTEXT = 65_536;

export function defaultContextTokens(model: Pick<LocalModel, 'maxContext'>): number {
  const trained = model.maxContext && model.maxContext > 0 ? model.maxContext : ENGINE_DEFAULT_CONTEXT;
  return Math.min(trained, ENGINE_DEFAULT_CONTEXT);
}
