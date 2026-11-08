/** Narrow local image-generation boundary (#2162). No paths, URLs or runtime overrides. */
export const PHONE_IMAGE_POLICY = {
  requestKeys: ['sessionId', 'prompt', 'params'],
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

export function phoneImageRequestProblem(value: unknown): string | null {
  if (!object(value)) return 'image request';
  for (const key of Object.keys(value)) if (!(PHONE_IMAGE_POLICY.requestKeys as readonly string[]).includes(key)) return key;
  if (typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) return 'sessionId';
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > PHONE_IMAGE_POLICY.promptChars) return 'prompt';
  return phoneImageParamsProblem(value.params, true);
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
