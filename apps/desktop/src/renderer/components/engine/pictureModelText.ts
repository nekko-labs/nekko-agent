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

/** "25 s", "2.5 min", "12 min": a picture takes seconds, a clip minutes. */
export function durationText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = seconds / 60;
  return `${minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes)} min`;
}

/**
 * How long a picture or clip takes, in words, when the recommendation has a
 * measured figure. "here" is this machine's own pictures; `~` marks a run on
 * the same kind of hardware. Nothing is said when nothing was measured.
 */
export function pictureTimeText(o: Pick<ImageRecommendedOption, 'capabilities' | 'time'>): { text: string; title: string } | null {
  const t = o.time;
  if (!t || !(t.seconds > 0)) return null;
  const thing = o.capabilities.includes('video') && !o.capabilities.includes('create') ? 'clip' : 'picture';
  if (t.basis === 'measuredHere') {
    return { text: `${durationText(t.seconds)} a ${thing} here`, title: `The median of the last ${t.samples ?? 'few'} ${thing}s this computer made with it, at the sizes and steps you used, with the model already loaded.` };
  }
  const at = t.width && t.height && t.steps ? ` at ${t.width}x${t.height} and ${t.steps} steps` : '';
  return { text: `~${durationText(t.seconds)} a ${thing}`, title: `Measured on the same kind of hardware${at}, with the model already loaded. Yours may differ.` };
}
