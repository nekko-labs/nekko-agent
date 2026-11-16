import type { ImageRecommendedOption } from '@nekko-agent/shared';

/** One line on what each set-up picture or video model is good at, by its id in the recommendation list. */
const BLURB: Record<string, string> = {
  'qwen-image': 'Best quality, and good at lettering inside pictures.',
  'z-image-turbo': 'Fast, with natural-looking pictures.',
  'flux2-klein-4b': 'Small and quick, and it can also edit photos.',
  'qwen-image-edit-2511': 'Precise edits that follow your instructions.',
  'wan2.2-ti2v-5b': 'Short video clips from a description or a first picture.',
};

/** What a set-up model is for, in words: its own line, or what its capabilities say when it has none yet. */
export function pictureModelBlurb(o: Pick<ImageRecommendedOption, 'modelId' | 'capabilities'>): string {
  if (BLURB[o.modelId]) return BLURB[o.modelId];
  if (o.capabilities.includes('video')) return 'Makes short video clips.';
  return o.capabilities.includes('edit') ? 'Creates and edits pictures.' : 'Creates pictures from a description.';
}
