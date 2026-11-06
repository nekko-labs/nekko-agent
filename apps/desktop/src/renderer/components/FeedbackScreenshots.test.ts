import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { screenshotPreviewUrl } from './FeedbackScreenshots.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02];

describe('screenshot previews', () => {
  it('uses a URL scheme the renderer CSP lets an image load', async () => {
    const url = await screenshotPreviewUrl(new File([new Uint8Array(PNG)], 'shot.png'));
    expect(url).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);

    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const imgSrc = /img-src ([^;]+);/.exec(html)![1]!.split(' ');
    expect(imgSrc).toContain(`${url.split(':')[0]}:`);
  });
});
