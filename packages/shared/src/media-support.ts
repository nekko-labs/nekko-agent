import type { ModelInfo, ProviderKind } from './models.js';
import { modelModality } from './engine.js';

/**
 * Whether the selected model can take photos and videos as input.
 *
 * The composer uses this to enable or disable the Photo / Video menu and to
 * explain, in plain words, why an attachment will not reach the model. It is a
 * best-effort read: a provider's catalog rarely says outright what a model can
 * see, so the answer comes from the strongest evidence available, in order:
 *
 *  1. The catalog itself (OpenRouter's `input_modalities`, stored in
 *     `details.inputModalities` as a comma-joined list).
 *  2. The model id / family, through the same architecture patterns the model
 *     library uses to label local files, plus the cloud families that are known
 *     to accept images (Claude 3+, GPT-4o/4.1/5, o-series, Gemini, Grok, Llama
 *     vision, Pixtral, Qwen-VL and friends).
 *  3. The provider: a cloud vendor whose current lineup is all multimodal
 *     (Anthropic, OpenAI, ChatGPT subscription) counts as image-capable even
 *     for an id these rules do not recognise, so a new release is not locked out.
 *
 * Video is far rarer. Only Gemini (and OpenRouter models that list `video`)
 * take video input today, so video reads as unsupported unless the catalog or
 * the family says otherwise. `unknown` is honest for a local or compat server
 * we cannot classify; the composer then allows the attachment and warns.
 */
export type MediaSupport = 'yes' | 'no' | 'unknown';

export interface ModelMediaSupport {
  image: MediaSupport;
  video: MediaSupport;
}

/** Cloud families whose current ids all accept image input. */
const IMAGE_FAMILIES =
  /claude-(?:3|[4-9]|\d{2,})|claude-(?:opus|sonnet|haiku|fable|mythos)|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-(?:5|[6-9]|\d{2,})|chatgpt-4o|\bo[1345](?:-|$)|gemini|gemma-?[3-9]|grok-(?:2|[3-9]|\d{2,})(?:-vision)?|grok-vision|llama-?(?:3\.2|4)|llama.*vision|pixtral|mistral-(?:medium|small)-(?:3|2[5-9]|\d{4})|magistral|qwen.*vl|qwen-?(?:3|[4-9])(?:\.\d)?-?(?:omni|vl)|kimi.*(?:vl|k2\.5)|glm-?4(?:\.\d)?v|internvl|llava|moondream|minicpm-?v|phi-?[34].*(?:vision|multimodal)|nova-(?:lite|pro|premier)|mistral-large-(?:3|2[5-9]|\d{4})|step-?[1-9].*v|deepseek.*(?:vl|ocr)|molmo|aria|idefics|smolvlm|paligemma/i;

/** Families that explicitly cannot see: text-only despite living in a sighted lineup. */
const TEXT_ONLY_FAMILIES =
  /gpt-3\.5|gpt-4-\d{4}$|gpt-4$|text-davinci|o1-mini|o3-mini|o4-mini|codex-mini|gpt-oss|deepseek-(?:chat|reasoner|r1|v3|v4)(?!.*(?:vl|vision))|mistral-(?:7b|tiny|nemo)|mixtral|codestral|devstral|command-r(?!.*vision)|command-a(?!.*vision)|llama-?3(?:\.[01])?-(?:8|70|405)b|llama-?3\.3|qwen(?:2\.5)?-coder|qwq|phi-?[34](?!.*(?:vision|multimodal))|embed|whisper|tts/i;

/** Families that accept video input. */
const VIDEO_FAMILIES = /gemini|qwen.*(?:omni|vl)|qwen-?(?:2\.5|3)-?(?:omni|vl)|nova-(?:lite|pro|premier)|internvl|llava-?(?:next-)?video|video-?llama/i;

function fromCatalog(details: Record<string, string> | undefined): ModelMediaSupport | null {
  const list = details?.inputModalities;
  if (!list) return null;
  const mods = list.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (!mods.length) return null;
  return { image: mods.includes('image') ? 'yes' : 'no', video: mods.includes('video') ? 'yes' : 'no' };
}

/** The id as the patterns expect it: lowercase, without a gateway's vendor prefix. */
function bareId(modelId: string): string {
  return modelId.toLowerCase().trim().replace(/^[^/]+\//, '');
}

/**
 * What the selected model accepts. `model` may be absent while the catalog is
 * still loading; the id and provider kind alone still give an answer.
 */
export function modelMediaSupport(input: {
  modelId?: string;
  providerKind?: ProviderKind;
  model?: Pick<ModelInfo, 'details' | 'name'> | null;
}): ModelMediaSupport {
  const catalog = fromCatalog(input.model?.details);
  if (catalog) return catalog;
  const id = bareId(input.modelId ?? '');
  const name = (input.model?.name ?? '').slice(0, 256);
  if (!id) return { image: 'unknown', video: 'unknown' };
  const video: MediaSupport = VIDEO_FAMILIES.test(id) || VIDEO_FAMILIES.test(name) ? 'yes' : 'no';
  if (TEXT_ONLY_FAMILIES.test(id)) return { image: 'no', video: 'no' };
  if (IMAGE_FAMILIES.test(id) || IMAGE_FAMILIES.test(name)) return { image: 'yes', video };
  // The library's architecture read for local files (llava, qwen-vl, gemma3...).
  if (modelModality({ name: id }) === 'vision' || modelModality({ name }) === 'vision') return { image: 'yes', video };
  switch (input.providerKind) {
    case 'anthropic':
    case 'bedrock':
    case 'openai':
    case 'chatgpt':
      // Every current model from these vendors takes images; an unrecognised
      // id is more likely a new release than a text-only one.
      return { image: 'yes', video: 'no' };
    case 'openrouter':
      // The catalog carries modalities; falling through here means it did not
      // list this id, so it stays honest.
      return { image: 'unknown', video: 'unknown' };
    default:
      // Local and compat servers: a plain chat model by default, but a model
      // we could not classify should not block the user.
      return { image: 'unknown', video: 'unknown' };
  }
}

/** A plain sentence for the composer when a media kind is not (or may not be) supported. */
export function mediaSupportNotice(kind: 'image' | 'video', support: MediaSupport, modelLabel: string): string | null {
  if (support === 'yes') return null;
  const what = kind === 'image' ? 'photos' : 'videos';
  if (support === 'no') return `${modelLabel} can't take ${what}. Pick a model with vision input to send them.`;
  return `${modelLabel} may not accept ${what}; it hasn't said. Send one to find out, or pick a model known to take them.`;
}

/** Whether a MIME type (or a file name) is a photo or a video the composer can carry. */
export function mediaKindOf(typeOrName: string): 'image' | 'video' | null {
  const t = typeOrName.toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?)$/.test(t)) return 'image';
  if (/\.(mp4|mov|webm|m4v|mkv|avi|mpeg|mpg)$/.test(t)) return 'video';
  return null;
}
