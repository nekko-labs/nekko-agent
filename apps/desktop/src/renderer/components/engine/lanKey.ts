import type { EngineSettings } from '@nekko-agent/shared';

/** 16 random bytes as 32 lowercase hex characters: a key nobody has to invent. */
export function generateApiKey(random: (buf: Uint8Array<ArrayBuffer>) => void = (b) => { globalThis.crypto.getRandomValues(b); }): string {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  random(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The settings after the user picks where the engine is reachable from.
 *
 * The engine refuses to bind the network without a key (#549), so choosing
 * the LAN with an empty key fills one in rather than leaving the user to run
 * into that refusal. A key the user already typed is kept, and going back to
 * loopback never touches the key.
 */
export function withBind(settings: EngineSettings, bind: EngineSettings['bind'], generate: () => string = generateApiKey): EngineSettings {
  const next = { ...settings, bind };
  if (bind === 'lan' && !(settings.apiKey ?? '').trim()) next.apiKey = generate();
  return next;
}
