import { describe, expect, it } from 'vitest';
import type { VoiceStatus } from '@nekko-agent/shared';
import { engineRows } from './voiceEngines.js';

const base: VoiceStatus = {
  installed: true, installing: false, progress: 0, running: false, supported: false, engine: 'apple',
  apple: { supported: true, installed: true, installing: false, locale: 'en-US' },
  whisper: { installed: false, installing: false, progress: 0 },
};

describe('engineRows', () => {
  it('lists Apple first, marks the active engine only once voice is enabled', () => {
    expect(engineRows(base).map(r => [r.id, r.active, r.action])).toEqual([['apple', false, 'remove'], ['whisper', false, null]]);
    expect(engineRows(base, { enabled: true }).map(r => r.active)).toEqual([true, false]);
  });
  it('hides Apple where no helper answered and offers the whisper download where it is verified', () => {
    const rows = engineRows({ ...base, engine: 'whisper', supported: true, apple: { supported: false, installed: false, installing: false } });
    expect(rows.map(r => [r.id, r.action])).toEqual([['whisper', 'install']]);
  });
  it('explains an unsupported Apple engine instead of offering an action', () => {
    const [apple] = engineRows({ ...base, apple: { supported: false, installed: false, installing: false, reason: 'Apple on-device speech needs macOS 26 or newer.' } });
    expect([apple.action, apple.detail]).toEqual([null, 'Apple on-device speech needs macOS 26 or newer.']);
  });
  it('shows the download progress on the whisper row', () => {
    const [, whisper] = engineRows({ ...base, supported: true, whisper: { installed: false, installing: true, progress: 0.4 } });
    expect(whisper.detail).toContain('downloading 40%');
  });
});
