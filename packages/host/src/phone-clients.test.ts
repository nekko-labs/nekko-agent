import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { IpcChannels, phoneChannelAllowed } from '@nekko-agent/shared';

/**
 * The phone access allowlist (packages/shared/src/phone-access.ts) must keep
 * every phone client working: each IPC channel named in their protocol code is
 * one a paired phone may call.
 */
it('allows every channel the phone clients call', () => {
  const repo = join(__dirname, '..', '..', '..');
  const sources = [
    'apps/mobile/src/lib/protocol.ts',
    'apps/android/protocol/src/main/kotlin/com/nekko/protocol/Wire.kt',
    'apps/ios/Protocol/Sources/NekkoProtocol/Wire.swift',
  ];
  const ipc = new Set<string>(Object.values(IpcChannels));
  const used = new Map<string, string>();
  for (const src of sources) {
    for (const [, ch] of readFileSync(join(repo, src), 'utf8').matchAll(/['"]([a-zA-Z]+:[a-zA-Z.]+)['"]/g)) {
      if (ipc.has(ch)) used.set(ch, src);
    }
  }
  expect(used.size).toBeGreaterThanOrEqual(15);
  for (const [ch, src] of used) expect(phoneChannelAllowed(ch), `${ch} (${src})`).toBe(true);
});
