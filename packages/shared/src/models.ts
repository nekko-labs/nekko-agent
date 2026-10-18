/** Provider + model domain types. */

import type { ModelAvailability } from './model-availability.js';

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'chatgpt'
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  /** The engine Nekko Agent runs itself (llama.cpp behind its own router). */
  | 'llamacpp'
  | 'openai-compat'
  /** Claude in Amazon Bedrock: the Messages API on the user's own Bedrock bearer token. */
  | 'bedrock';

/** A configured connection to a model server / provider. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Base URL for the server. For cloud providers this defaults per-kind. */
  baseUrl: string;
  /** API key (cloud) or token (some local servers). Stored locally. */
  apiKey?: string;
  /** Auth mode: 'apikey' is the default, 'subscription' pulls a fresh OAuth token. */
  auth?: 'apikey' | 'subscription';
  /** Vendor account id (decoded from ChatGPT id_token, or a stable account handle). */
  accountId?: string;
  /** Key into the host's token store. This is not the token itself. */
  tokenKey?: string;
  /** Whether this provider was auto-discovered on the local network. */
  discovered?: boolean;
  /** Free-text model id override, currently used by the ChatGPT provider. */
  customModelId?: string;
  /** Host-only assertion for a trusted managed llama.cpp endpoint. Never trust persisted input. */
  managedCachePrompt?: boolean;
  enabled: boolean;
}

/** A model exposed by a provider. */
export interface ModelInfo {
  id: string;
  providerId: string;
  /** Display name. */
  name: string;
  /** Context window in tokens, if known. */
  contextLength?: number;
  /** Whether this model is currently loaded into memory (ollama/lmstudio/vllm). */
  loaded?: boolean;
  /** Approximate size on disk in bytes, if known. */
  sizeBytes?: number;
  /** VRAM currently used by this model while loaded, in bytes (ollama). */
  vramBytes?: number;
  /** Family / quantization hints. */
  details?: Record<string, string>;
  /**
   * Real USD prices per million tokens, when the provider publishes them
   * (OpenRouter does). Preferred over the static MODEL_PRICING table because
   * they are the meter the bill actually runs on.
   */
  inputPricePerM?: number;
  outputPricePerM?: number;
  /**
   * What the provider already knows about whether this model can be run, for a
   * catalog that ships entries it can't always serve (a model gated behind a
   * bigger plan, one the vendor retired). Live usage limits are layered on top
   * by `resolveModelAvailability`; leave this unset and the model reads as ready.
   */
  availability?: ModelAvailability;
}

/**
 * Whether per-model load/unload is available for an LM Studio provider (driven
 * by its `lms` CLI). Unavailable for a remote server or when `lms` isn't
 * installed; `reason` is a UI-ready explanation for those cases.
 */
export interface LmsProbe {
  available: boolean;
  reason?: string;
}

/**
 * Local model-server kinds (on-device servers we can inspect and manage).
 * `openai-compat` is deliberately absent: the kind is dual-use (a localhost
 * server or a remote gateway), so it is grouped with the online/other
 * providers everywhere and genuinely-local behavior keys off the loopback URL
 * rather than the kind.
 */
export const LOCAL_PROVIDER_KINDS: ProviderKind[] = ['llamacpp', 'ollama', 'lmstudio', 'vllm'];

/** Whether a provider kind is an on-device local model server. */
export function isLocalProvider(kind: ProviderKind): boolean {
  return LOCAL_PROVIDER_KINDS.includes(kind);
}

/**
 * A single GPU's memory snapshot (megabytes). Utilization is 0-100 when known.
 */
export interface GpuDevice {
  name: string;
  memoryTotalMB: number;
  memoryUsedMB: number;
  memoryFreeMB: number;
  utilizationPct?: number;
  /** Core temperature in °C, when the probe reports one (nvidia-smi does). */
  temperatureC?: number;
}

/**
 * Where a GPU reading came from. `nvidia-smi` is the NVIDIA driver query (Windows
 * and Linux); `ioreg` is the macOS accelerator driver's own statistics, which
 * needs no admin rights (unlike `powermetrics`); `llama-server` is the engine's
 * own `--list-devices`, the fallback where the vendor tool is missing or fails
 * (old NVIDIA drivers, AMD and Intel GPUs). It reports no utilization.
 */
export type GpuSource = 'nvidia-smi' | 'ioreg' | 'llama-server' | 'none';

/**
 * Aggregate GPU/VRAM stats, surfaced in the Chat metrics bar and Command Center.
 * `source` records where the numbers came from so the UI can label them honestly;
 * totals are summed across all devices.
 */
export interface GpuStats {
  source: GpuSource;
  devices: GpuDevice[];
  totalMB: number;
  usedMB: number;
  freeMB: number;
  /**
   * The GPU shares one memory pool with the CPU (Apple Silicon), so `totalMB` is
   * system RAM rather than a dedicated card's VRAM. The UI labels the memory
   * meter differently when this is set, so nobody reads it as discrete VRAM.
   */
  unified?: boolean;
}

/** How the memory meter should name itself for a given GPU source. */
export function gpuMemoryLabel(stats: Pick<GpuStats, 'unified'> | null): string {
  return stats?.unified ? 'GPU memory' : 'VRAM';
}

/**
 * Reasoning ("thinking") model detection by id/name. Covers the common local and
 * cloud reasoning families (DeepSeek-R1, Qwen3, QwQ, Magistral, gpt-oss,
 * phi-4-reasoning, o1/o3/o4, Gemini thinking, …). Used to decide whether to offer
 * the per-chat thinking toggle. `gpt-?[5-9]` covers the whole reasoning
 * generation: GPT-5 through the GPT-6 picker ids.
 */
const THINKING_MODEL_RE =
  /(?:^|[-_/ .])(?:r1|reason|reasoning|qwq|qwen-?3|magistral|thinking|think|o1|o3|o4|gpt-?[5-9]|gpt-oss|deepseek-?r|phi-?4-reasoning|cogito|marco-o1|sky-t1|deephermes)/i;

export function modelSupportsThinking(model: { id: string; name?: string }): boolean {
  return THINKING_MODEL_RE.test(`${model.id} ${model.name ?? ''}`);
}

/**
 * The engine's canonical port.
 *
 * One constant rather than a convention, because three places must agree: the
 * engine's own settings default, the provider entry the host keeps pointing at
 * it, and the URL a user types into another tool.
 */
export const ENGINE_PORT_DEFAULT = 11500;

/** Default base URLs per provider kind. */
export const PROVIDER_DEFAULTS: Record<ProviderKind, { baseUrl: string; needsKey: boolean; label: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', needsKey: true, label: 'Anthropic (Claude)' },
  openai: { baseUrl: 'https://api.openai.com/v1', needsKey: true, label: 'OpenAI' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, label: 'OpenRouter' },
  chatgpt: { baseUrl: 'https://chatgpt.com/backend-api', needsKey: false, label: 'ChatGPT (subscription)' },
  ollama: { baseUrl: 'http://localhost:11434', needsKey: false, label: 'Ollama' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', needsKey: false, label: 'LM Studio' },
  vllm: { baseUrl: 'http://localhost:8000/v1', needsKey: false, label: 'vLLM' },
  llamacpp: { baseUrl: `http://127.0.0.1:${ENGINE_PORT_DEFAULT}/v1`, needsKey: false, label: 'Nekko Agent engine' },
  'openai-compat': { baseUrl: 'http://localhost:8080/v1', needsKey: false, label: 'OpenAI-compatible' },
  // The region is part of the host: edit it to match the Bedrock region you use.
  bedrock: { baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic', needsKey: true, label: 'Claude in Amazon Bedrock' },
};

/** Ports we probe when auto-discovering local servers. */
export const DISCOVERY_TARGETS: Array<{ kind: ProviderKind; baseUrl: string; probe: string }> = [
  { kind: 'ollama', baseUrl: 'http://localhost:11434', probe: '/api/tags' },
  { kind: 'lmstudio', baseUrl: 'http://localhost:1234/v1', probe: '/models' },
  { kind: 'vllm', baseUrl: 'http://localhost:8000/v1', probe: '/models' },
];
