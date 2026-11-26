import { describe, expect, it, vi } from 'vitest';
import { LANGUAGES, languagePatch, resolveLang } from './i18n.js';
import { onboardingMessages, onboardingText } from './onboardingMessages.js';

vi.mock('./store.js', () => ({ useStore: () => undefined }));

describe('desktop app language', () => {
  it('finds the first supported preference, including regional tags and script tags', () => {
    expect(resolveLang(undefined, ['nl-NL', 'pt-BR', 'en-US'])).toBe('pt');
    expect(resolveLang(undefined, [' ZH_hans_CN ', 'ja-JP'])).toBe('zh');
    expect(resolveLang(undefined, ['ja-JP', 'en-US'])).toBe('ja');
  });

  it('uses English only when no available preference is supported', () => {
    expect(resolveLang(undefined, ['it-IT'])).toBe('en');
    expect(resolveLang('invalid', ['de-DE'])).toBe('de');
  });

  it('restores a saved override and recognizes the persisted system reset', () => {
    const store = (value: 'fr' | '') => JSON.parse(JSON.stringify(languagePatch(value))).language;
    expect(resolveLang(store('fr'), ['es-MX'])).toBe('fr');
    expect(store('')).toBe('');
    expect(resolveLang(store(''), ['es-MX'])).toBe('es');
  });

  it('keeps onboarding translations and their named placeholders aligned', () => {
    const placeholders = (value: string) => value.match(/\{\w+\}/g)?.sort() ?? [];
    for (const [key, messages] of Object.entries(onboardingMessages)) {
      for (const { code } of LANGUAGES) {
        expect(messages[code].trim(), `${key}/${code}`).not.toBe('');
        expect(placeholders(messages[code]), `${key}/${code}`).toEqual(placeholders(messages.en));
      }
    }
    expect(onboardingText('ja', 'greetingNamed', { name: 'Álvaro' })).toBe('Álvaroさん、今日は何をしましょうか？');
  });
});
