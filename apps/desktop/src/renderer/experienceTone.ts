/** Tone lives in the existing additive instructions, never a replacement prompt. */
export const TONES = {
  Default: '',
  Friendly: 'Use a warm, approachable tone. Stay honest, clear and concise.',
  Professional: 'Use a calm, professional tone with precise, direct language.',
  Concise: 'Keep replies brief and focused on the answer, essential caveats and next steps.',
  Explanatory: 'Explain the reasoning at a useful level, with clear examples when helpful.',
} as const;
export type ExperienceTone = keyof typeof TONES;
const block = /(?:\n\n)?<nekko-tone>\n(Default|Friendly|Professional|Concise|Explanatory)\n[^]*?\n<\/nekko-tone>/g;
export function readTone(instructions: string): ExperienceTone {
  const matches = [...instructions.matchAll(new RegExp(block))];
  return (matches.at(-1)?.[1] as ExperienceTone | undefined) ?? 'Default';
}
export function withTone(instructions: string, tone: ExperienceTone): string {
  const original = instructions.replace(new RegExp(block), '');
  return tone === 'Default' ? original : `${original}${original ? '\n\n' : ''}<nekko-tone>\n${tone}\n${TONES[tone]}\n</nekko-tone>`;
}
