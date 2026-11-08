/**
 * Narrow local image-generation boundary (#2162). No paths, URLs or runtime overrides.
 * Photos to edit (`images`) and the edit's size (`size`) are optional (decision 0069, #2222).
 */
export const PHONE_IMAGE_POLICY = {
  requestKeys: ['sessionId', 'prompt', 'params', 'images', 'size'],
  paramKeys: ['modelId', 'width', 'height', 'steps', 'cfgScale', 'seed'],
  promptChars: 8000,
  idChars: 512,
  sessionIdChars: 128,
  width: [256, 2048],
  height: [256, 2048],
  sizeMultiple: 64,
  steps: [1, 100],
  cfgScale: [0, 30],
  seed: [-1, 2147483647],
  /** Photos to edit in one request: 1 to this many, as the engine allows. */
  editImages: 4,
  /** Raster data URLs only (`data:image/<type>;base64,`): no SVG, GIF, paths or URLs. */
  editImageTypes: ['png', 'jpeg', 'webp'],
  /**
   * All photos together, in characters, from a phone: one sealed relay frame
   * (10 MB, base64 adds a third) still holds them with the rest of the call.
   * The local host API has no relay frame and no such cap.
   */
  editImageChars: 6 * 1024 * 1024,
  sizeKeys: ['width', 'height'],
} as const;

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Library ids may contain relative folder segments, never absolute paths or traversal. */
export function phoneImageModelId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= PHONE_IMAGE_POLICY.idChars &&
    v.trim() === v && !/[\\:\x00-\x1f\x7f]/.test(v) && !v.startsWith('/') && !v.startsWith('-') &&
    v.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Return the offending field. Generation requires all six fields; saved option patches may be partial. */
export function phoneImageParamsProblem(value: unknown, requireModel: boolean): string | null {
  if (!object(value)) return 'imageParams';
  for (const key of Object.keys(value)) if (!(PHONE_IMAGE_POLICY.paramKeys as readonly string[]).includes(key)) return key;
  if ((requireModel || 'modelId' in value) && !phoneImageModelId(value.modelId)) return 'modelId';
  for (const key of ['width', 'height', 'steps', 'cfgScale', 'seed'] as const) {
    if (!(key in value)) {
      if (requireModel) return key;
      continue;
    }
    const n = value[key];
    const [min, max] = PHONE_IMAGE_POLICY[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max ||
      ((key === 'width' || key === 'height') && n % PHONE_IMAGE_POLICY.sizeMultiple !== 0)) return key;
  }
  return null;
}

/** A PNG, JPEG or WebP base64 data URL: the only photo a request may carry. */
export function phoneImagePhoto(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const type = PHONE_IMAGE_POLICY.editImageTypes.find((t) => v.startsWith(`data:image/${t};base64,`));
  return !!type && /^[A-Za-z0-9+/]+={0,2}$/.test(v.slice(`data:image/${type};base64,`.length));
}

/**
 * Photos to edit and the edit's size. `size` without `images` is refused: it
 * only ever shapes an edit, so on its own it is a malformed request.
 */
function phoneImageEditProblem(value: Obj): string | null {
  const p = PHONE_IMAGE_POLICY;
  if ('images' in value) {
    const images = value.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > p.editImages || !images.every(phoneImagePhoto) ||
      (images as string[]).reduce((n, i) => n + i.length, 0) > p.editImageChars) return 'images';
  }
  if ('size' in value) {
    const size = value.size;
    if (!('images' in value) || !object(size) || Object.keys(size).length !== p.sizeKeys.length) return 'size';
    for (const key of p.sizeKeys) {
      const n = size[key];
      const [min, max] = p[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max || n % p.sizeMultiple !== 0) return 'size';
    }
  }
  return null;
}

export function phoneImageRequestProblem(value: unknown): string | null {
  if (!object(value)) return 'image request';
  for (const key of Object.keys(value)) if (!(PHONE_IMAGE_POLICY.requestKeys as readonly string[]).includes(key)) return key;
  if (typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) return 'sessionId';
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > PHONE_IMAGE_POLICY.promptChars) return 'prompt';
  return phoneImageParamsProblem(value.params, true) ?? phoneImageEditProblem(value);
}

/** Actual engine library rows use modality and loaded, not the phone's kind/state fields. */
export function phoneImageModels(result: unknown): Obj[] {
  if (!Array.isArray(result)) return [];
  return result.filter((r) => object(r) && r.modality === 'image' &&
    (r.format === undefined || r.format === 'gguf') && phoneImageModelId(r.id)).map((r: Obj) => ({
      id: r.id,
      name: phoneImageModelId(r.name) && !r.name.includes('/') ? r.name : r.id,
      kind: 'image',
      format: 'gguf',
      state: r.loaded === true ? 'loaded' : r.lastLoadError ? 'error' : 'available',
    }));
}
