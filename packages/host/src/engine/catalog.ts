import type { CatalogModel, CatalogModelDetail, CatalogQuant } from '@nekko-agent/shared';

/**
 * Where models come from.
 *
 * Two sources, deliberately. A **curated** list answers the question a new user
 * actually has, which is not "search Hugging Face" but "what should I run on
 * this machine"; it is small, opinionated, and every entry is a GGUF repo that
 * exists. **Search** is the escape hatch for everyone else, straight against the
 * Hugging Face API with no key, because pinning people to our list would make
 * this worse than the thing it replaces.
 *
 * Sizes come from the repo's file tree rather than from the model card, so the
 * figure in the picker is the number of bytes that will actually be transferred.
 */

const HF_API = 'https://huggingface.co/api';

/** Quant names ordered worst-to-best, for sorting a repo's files sensibly. */
const QUANT_ORDER = [
  'IQ1', 'IQ2', 'Q2_K', 'IQ3', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'IQ4', 'Q4_K_S', 'Q4_K_M',
  'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'MXFP4', 'BF16', 'F16', 'F32',
];

/** What each quant is for, in the one line a picker has room for. */
const QUANT_NOTES: Record<string, string> = {
  Q3_K_M: 'Smallest useful size. Noticeably rougher.',
  Q4_K_M: 'The usual choice: best balance of size and quality.',
  Q5_K_M: 'A little larger, a little better.',
  Q6_K: 'Close to full quality, much bigger.',
  Q8_0: 'Effectively full quality. Large.',
  F16: 'Unquantized. Very large.',
};

/**
 * Small files a GGUF needs beside it to actually run.
 *
 * The weights are not the whole model: a repo's chat template is what turns
 * messages into a prompt, its tokenizer config is what other runtimes (vLLM's
 * GGUF path, HF tooling) demand next to the file, and its projector is what a
 * vision model uses to see. Individually kilobytes; together they are the
 * difference between a download that runs and one that errors on first use.
 * Matched by basename at any depth, size-capped so a stray artifact (a nested
 * safetensors) cannot sneak onto the list.
 */
const SIDECAR_FILES = new Set([
  'chat_template.jinja',
  'chat_template.json',
  'chat-template.jinja',
  'tokenizer_config.json',
  'tokenizer.json',
  'tokenizer.model',
  'config.json',
  'generation_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'merges.txt',
  'vocab.json',
  'preprocessor_config.json',
  'processor_config.json',
]);
const SIDECAR_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The starter list.
 *
 * Kept short on purpose: this is the "what do I run" answer, not a directory.
 * Every entry is a repo of GGUF files, and the quants are discovered from the
 * repo rather than hardcoded, so a repo adding a build shows up without an edit
 * here.
 */
export const CURATED: Array<Omit<CatalogModel, 'quants'>> = [
  {
    id: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    name: 'Qwen2.5 7B Instruct',
    owner: 'Qwen',
    parameterSize: '7B',
    summary: 'A strong all-rounder for chat and tools that fits comfortably on most machines.',
    tags: ['chat', 'tools'],
    curated: true,
  },
  {
    id: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    name: 'Qwen2.5 Coder 7B',
    owner: 'Qwen',
    parameterSize: '7B',
    summary: 'The pick for code: reading, writing, and editing it, same footprint as the all-rounder.',
    tags: ['code', 'tools'],
    curated: true,
  },
  {
    id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    name: 'Llama 3.1 8B Instruct',
    owner: 'Meta',
    parameterSize: '8B',
    summary: 'A widely supported general model with a long context.',
    tags: ['chat', 'tools'],
    curated: true,
  },
  {
    id: 'bartowski/google_gemma-3-12b-it-GGUF',
    name: 'Gemma 3 12B',
    owner: 'Google',
    parameterSize: '12B',
    summary: 'Larger and more capable, and it can read images.',
    tags: ['chat', 'vision'],
    curated: true,
  },
  {
    id: 'unsloth/Qwen3-4B-GGUF',
    name: 'Qwen3 4B',
    owner: 'Qwen',
    parameterSize: '4B',
    summary: 'Small and fast, with optional step-by-step reasoning. The easiest one to start with.',
    tags: ['chat', 'reasoning'],
    curated: true,
    recommended: true,
  },
  {
    id: 'ggml-org/gpt-oss-20b-GGUF',
    name: 'gpt-oss 20B',
    owner: 'OpenAI',
    parameterSize: '20B',
    summary: 'An open-weight reasoning model. Needs a roomy GPU.',
    tags: ['chat', 'reasoning', 'tools'],
    curated: true,
  },
  {
    id: 'CompendiumLabs/bge-small-en-v1.5-gguf',
    name: 'BGE Small (embeddings)',
    owner: 'BAAI',
    parameterSize: '33M',
    summary: 'Turns text into vectors for search. Tiny.',
    tags: ['embedding'],
    curated: true,
  },
];

export interface CatalogDeps {
  fetch?: typeof fetch;
  /** Optional HF token, for gated repos the user has access to. */
  token?: () => string | undefined;
  /**
   * Whether MLX can run here (an Apple Silicon Mac). Elsewhere MLX folders
   * are never offered, so a model page cannot download one that cannot run.
   */
  mlx?: () => boolean;
}

export function createCatalog(deps: CatalogDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cache = new Map<string, { at: number; value: CatalogModel | null }>();
  const CACHE_TTL_MS = 10 * 60_000;

  function headers(): Record<string, string> {
    const token = deps.token?.();
    return {
      accept: 'application/json',
      'user-agent': 'nekko-agent',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /** The starter list, with each repo's real files and sizes filled in. */
  async function curated(): Promise<CatalogModel[]> {
    const filled = await Promise.all(
      CURATED.map(async (entry) => {
        const quants = await quantsFor(entry.id);
        return { ...entry, quants };
      }),
    );
    // A repo that has been renamed or pulled should drop off the list rather than
    // render as an entry with nothing to download.
    return filled.filter((m) => m.quants.length > 0);
  }

  /**
   * Free-text search over Hugging Face: GGUF repos, or MLX checkpoints for an
   * Apple Silicon Mac (mostly `mlx-community` conversions, one quantization
   * per repo).
   */
  async function search(query: string, limit = 20, format: 'gguf' | 'mlx' = 'gguf'): Promise<CatalogModel[]> {
    const q = query.trim();
    if (!q && format === 'gguf') return curated();
    // MLX: the `mlx` tag, text models only (mlx_lm.server serves those; mlx-community also carries audio).
    const filter = format === 'mlx' ? 'filter=mlx&pipeline_tag=text-generation' : 'filter=gguf';
    const url = `${HF_API}/models?${filter}&search=${encodeURIComponent(q)}&sort=downloads&direction=-1&limit=${limit}&full=true`;
    const rows = await getJson<Array<HfModelRow>>(url);
    if (!rows) return [];

    // Sizes need one tree request per repo, so they are fetched for the page of
    // results being shown rather than for everything the search matched.
    return (
      await Promise.all(
        rows.slice(0, limit).map(async (row): Promise<CatalogModel | null> => {
          const id = row.id ?? row.modelId;
          if (!id) return null;
          const quants = await quantsFor(id, row.tags, format);
          if (quants.length === 0) return null;
          const [owner, repo] = id.split('/');
          return {
            id,
            name: prettyName(repo ?? id),
            owner: owner ?? 'unknown',
            parameterSize: paramHint(repo ?? ''),
            tags: capabilityTags(row.tags ?? [], repo ?? ''),
            quants,
            downloads: row.downloads,
            likes: row.likes,
            updatedAt: asTime(row.lastModified),
            createdAt: asTime(row.createdAt),
            pipelineTag: row.pipeline_tag,
            baseModel: baseModelOf(row.tags ?? []),
            hfTags: row.tags,
            gated: Boolean(row.gated),
          } satisfies CatalogModel;
        }),
      )
    ).filter((m): m is CatalogModel => m !== null);
  }

  /** One repo's detail, including every GGUF it publishes. */
  async function model(id: string): Promise<CatalogModel | null> {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const info = await getJson<HfModelRow>(`${HF_API}/models/${id}`);
    const quants = await quantsFor(id, info?.tags);
    const [owner, repo] = id.split('/');
    const value: CatalogModel | null =
      quants.length > 0
        ? {
            id,
            name: prettyName(repo ?? id),
            owner: owner ?? 'unknown',
            parameterSize: paramHint(repo ?? ''),
            summary: info?.cardData?.summary,
            tags: capabilityTags(info?.tags ?? [], repo ?? ''),
            quants,
            downloads: info?.downloads,
            likes: info?.likes,
            updatedAt: asTime(info?.lastModified),
            createdAt: asTime(info?.createdAt),
            pipelineTag: info?.pipeline_tag,
            baseModel: info?.cardData?.base_model ?? baseModelOf(info?.tags ?? []),
            hfTags: info?.tags,
            license: info?.cardData?.license ?? licenseOf(info?.tags ?? []),
            gated: Boolean(info?.gated),
          }
        : null;
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * One model's own page: everything `model` returns plus its card.
   *
   * The card is a README that can run to thousands of words, so it is fetched
   * only when a model is opened. A card that will not load is reported rather
   * than swallowed, because "this publisher wrote nothing" and "we could not
   * reach Hugging Face" are different things and the page should not claim the
   * first when it means the second.
   */
  async function detail(id: string): Promise<CatalogModelDetail | null> {
    const [base, card] = await Promise.all([model(id), readme(id)]);
    if (!base) return null;
    return { ...base, readme: card.text, readmeError: card.error };
  }

  /** The model card, front matter stripped: the page renders the prose. */
  async function readme(id: string): Promise<{ text?: string; error?: string }> {
    try {
      const res = await doFetch(`https://huggingface.co/${id}/raw/main/README.md`, { headers: headers() });
      if (res.status === 404) return {};
      if (!res.ok) return { error: `Hugging Face answered ${res.status}.` };
      return { text: stripFrontMatter(await res.text()) };
    } catch {
      return { error: "Couldn't reach Hugging Face for the model card." };
    }
  }

  /** A repo's file tree, the one request everything else is computed from. */
  async function treeFor(id: string): Promise<Array<{ type?: string; path?: string; size?: number }> | null> {
    return getJson<Array<{ type?: string; path?: string; size?: number }>>(
      `${HF_API}/models/${id}/tree/main?recursive=true`,
    );
  }

  /** The projector and the config/tokenizer sidecars a repo ships, if any. */
  function companionsOf(tree: Array<{ type?: string; path?: string; size?: number }>): {
    projector?: string;
    sidecars: string[];
  } {
    const projector = tree.find(
      (f) => f.type !== 'directory' && /mmproj/i.test(f.path ?? '') && f.path?.toLowerCase().endsWith('.gguf'),
    )?.path;
    const sidecars = tree
      .filter(
        (f) =>
          f.type !== 'directory' &&
          f.path &&
          SIDECAR_FILES.has((f.path.split('/').pop() ?? '').toLowerCase()) &&
          (f.size ?? 0) <= SIDECAR_MAX_BYTES,
      )
      .map((f) => f.path as string);
    return { projector, sidecars };
  }

  /**
   * The files a model already on disk could be missing: its projector and the
   * small configs. Used when the weights arrived without them (a manual
   * download, a file copied out of another app). Null when the repo cannot be
   * read at all, which is a different problem from "nothing to fetch".
   */
  async function companions(id: string): Promise<{ projector?: string; sidecars: string[] } | null> {
    const tree = await treeFor(id);
    return tree ? companionsOf(tree) : null;
  }

  /**
   * A repo's GGUF files as quantization options.
   *
   * Split models (`-00001-of-00003.gguf`) are collapsed onto their first shard
   * and carry the rest as `extraFiles`, because downloading one shard of three
   * produces a file that looks fine and cannot load.
   */
  async function quantsFor(id: string, tags?: string[], format?: 'gguf' | 'mlx'): Promise<CatalogQuant[]> {
    const tree = await treeFor(id);
    if (!tree) return [];

    const ggufs = tree.filter((f) => f.type !== 'directory' && f.path?.toLowerCase().endsWith('.gguf'));
    const mlx = deps.mlx?.() ? mlxQuant(id, tree, tags?.includes('mlx')) : null;
    // An MLX search offers the MLX folder even from a repo that also ships GGUFs.
    if (format === 'mlx' || ggufs.length === 0) return mlx ? [mlx] : [];
    const byGroup = new Map<string, Array<{ path: string; size: number }>>();
    for (const f of ggufs) {
      const path = f.path as string;
      // A projector is a companion for vision models, never a model on its own.
      if (/mmproj/i.test(path)) continue;
      const group = path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf');
      const list = byGroup.get(group) ?? [];
      list.push({ path, size: f.size ?? 0 });
      byGroup.set(group, list);
    }

    const { projector, sidecars } = companionsOf(tree);

    const quants: CatalogQuant[] = [];
    for (const [group, parts] of byGroup) {
      parts.sort((a, b) => a.path.localeCompare(b.path));
      const label = quantLabel(group);
      quants.push({
        label,
        file: parts[0].path,
        sizeBytes: parts.reduce((n, p) => n + p.size, 0),
        extraFiles: [...parts.slice(1).map((p) => p.path), ...(projector ? [projector] : []), ...sidecars],
        note: QUANT_NOTES[label],
      });
    }
    // A repo with both offers both, so a model page can download either.
    return [...quants.sort((a, b) => rank(a.label) - rank(b.label)), ...(mlx ? [mlx] : [])];
  }

  async function getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await doFetch(url, { headers: headers() });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  return { curated, search, model, detail, quantsFor, companions };
}

/** The shape of a Hugging Face model row, as much of it as we read. */
interface HfModelRow {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  createdAt?: string;
  pipeline_tag?: string;
  gated?: boolean | string;
  tags?: string[];
  cardData?: { license?: string; base_model?: string; summary?: string };
}

function asTime(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** Hugging Face files both of these as tags, e.g. `base_model:Qwen/Qwen3-4B`. */
function baseModelOf(tags: string[]): string | undefined {
  return tags.find((t) => t.startsWith('base_model:'))?.split(':').slice(1).join(':') || undefined;
}
function licenseOf(tags: string[]): string | undefined {
  return tags.find((t) => t.startsWith('license:'))?.slice('license:'.length) || undefined;
}

/**
 * Drop the YAML block a model card opens with.
 *
 * It is metadata for the Hub, not prose for a reader, and rendering it puts
 * thirty lines of `tags:` above the first sentence anybody wants.
 */
export function stripFrontMatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown.trim();
  const close = markdown.indexOf('\n---', 3);
  if (close === -1) return markdown.trim();
  const after = markdown.indexOf('\n', close + 1);
  return (after === -1 ? '' : markdown.slice(after + 1)).trim();
}

export type Catalog = ReturnType<typeof createCatalog>;

/** The URL a repo file is fetched from. */
export function hfFileUrl(repoId: string, file: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`;
}

/** `...-Q4_K_M.gguf` -> `Q4_K_M`, falling back to the bare file name. */
function quantLabel(file: string): string {
  const base = file.split('/').pop() ?? file;
  const m = base.match(/[-_.]((?:IQ|Q)\d+[A-Z0-9_]*|BF16|F16|F32|MXFP4[A-Z0-9_]*)\.gguf$/i);
  return m ? m[1].toUpperCase() : base.replace(/\.gguf$/i, '');
}

function rank(label: string): number {
  const i = QUANT_ORDER.findIndex((q) => label.toUpperCase().startsWith(q));
  return i === -1 ? QUANT_ORDER.length : i;
}

function prettyName(repo: string): string {
  return repo.replace(/[-_]?GGUF$/i, '').replace(/[-_]/g, ' ').trim();
}

/** `Qwen2.5-7B-Instruct` -> `7B`. Display only; never used for sizing. */
function paramHint(repo: string): string | undefined {
  return repo.match(/(\d+(?:\.\d+)?[BM])(?![a-z])/i)?.[1]?.toUpperCase();
}

/**
 * Capability tags, from the repo's own tags plus the name.
 *
 * Name matching is a hint, not a claim: it decides which chips a card shows, and
 * nothing downstream depends on it being right.
 */
function capabilityTags(hfTags: string[], repo: string): string[] {
  const text = `${hfTags.join(' ')} ${repo}`.toLowerCase();
  const tags: string[] = [];
  if (/embed|bge|e5-|gte-/.test(text)) tags.push('embedding');
  else tags.push('chat');
  if (/coder|code|starcoder|deepseek-?coder/.test(text)) tags.push('code');
  if (/reason|r1|qwq|thinking|gpt-oss/.test(text)) tags.push('reasoning');
  if (/vision|vl|multimodal|llava|gemma-3/.test(text)) tags.push('vision');
  return tags;
}

/**
 * Files an MLX checkpoint folder needs: its config, weights and tokenizer.
 * READMEs, images and other formats in the same repo are left behind.
 */
const MLX_FILE = /(^|\/)(config\.json|generation_config\.json|.*\.safetensors|model\.safetensors\.index\.json|tokenizer[^/]*|special_tokens_map\.json|vocab\.(json|txt)|merges\.txt|[^/]*\.tiktoken|chat_template\.(json|jinja)|preprocessor_config\.json|processor_config\.json)$/i;

/**
 * An MLX repo as one download: the whole folder, sized as the sum of its files.
 * A repo is MLX when it has a `config.json` beside `.safetensors` weights at
 * its root and either carries Hugging Face's `mlx` tag or says so in its id
 * (`mlx-community/...`, `...-MLX-4bit`). It lands in `<models>/mlx/`, which is
 * what makes the library read the folder as MLX.
 */
export function mlxQuant(id: string, tree: Array<{ type?: string; path?: string; size?: number }>, taggedMlx = false): CatalogQuant | null {
  const files = tree.filter((f) => f.type !== 'directory' && f.path && !f.path.includes('/') && MLX_FILE.test(f.path));
  const weights = files.filter((f) => f.path!.toLowerCase().endsWith('.safetensors')).sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  if (!files.some((f) => f.path === 'config.json') || weights.length === 0 || !(taggedMlx || /mlx/i.test(id))) return null;
  const main = weights[0].path as string;
  // Bounded on both sides: repo ids come from Hugging Face, and an unbounded
  // `\d+` before an optional separator backtracks on long runs of digits.
  const name = id.slice(0, 200);
  const bits = name.match(/(?:^|\D)(\d{1,3})[-_]?bit/i)?.[1];
  const label = bits ? `${bits}bit` : /bf16/i.test(name) ? 'BF16' : /fp16|f16/i.test(name) ? 'FP16' : 'MLX';
  return {
    label,
    file: main,
    sizeBytes: files.reduce((n, f) => n + (f.size ?? 0), 0),
    extraFiles: files.map((f) => f.path as string).filter((p) => p !== main).sort(),
    note: 'MLX, for Apple Silicon',
    format: 'mlx',
  };
}
