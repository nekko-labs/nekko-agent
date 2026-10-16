import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localImageData } from '../localImages.js';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('image and hardware regression boundaries', () => {
  it('keeps the prompt until image prerequisites have been checked', () => {
    const text = source('./ChatPane.tsx');
    const turn = text.slice(text.indexOf('const sendImage ='), text.indexOf('const send ='));
    expect(turn.indexOf('engineImageCompanions')).toBeLessThan(turn.indexOf("setDraft('')"));
    expect(turn).toContain('!runtime.diffusionInstall?.binPath');
    expect(turn).toContain('setup && !setup.ready');
  });
  it('polls hardware twice as often without a longer GPU cache', () => {
    expect(source('./ResourceMonitor.tsx')).toContain('const POLL_MS = 2000;');
    const gpu = source('../../../../../packages/host/src/gpu.ts');
    expect(gpu).toContain('const TTL_MS = 1000;');
    expect(gpu).toContain('if (inFlight) return inFlight;');
  });
  it('allows only complete text SVG as inert image data, never as a raster response', () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const file = { content, binary: false, truncated: false };
    expect(localImageData('/a.svg', file)).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`);
    for (const rejected of [{ ...file, binary: true }, { ...file, truncated: true }, { ...file, content: '' }, { ...file, content: 'x'.repeat(1_000_001) }]) {
      expect(localImageData('/a.svg', rejected)).toBeNull();
    }
    expect(localImageData('/a.png', { ...file, imageDataUrl: 'data:image/svg+xml;base64,AAAA' })).toBeNull();
    expect(source('./FilePane.tsx')).toContain('title="Download a copy of this file"');
  });
});
