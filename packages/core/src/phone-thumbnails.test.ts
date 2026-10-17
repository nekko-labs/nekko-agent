import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { PHONE_SESSION_VIEW } from '@nekko-agent/shared';
import { phoneThumbnail } from './phone-thumbnails.js';

async function photo(w: number, h: number): Promise<string> {
  const img = new Jimp({ width: w, height: h, color: 0x6d5efcff });
  return `data:image/png;base64,${(await img.getBuffer('image/png')).toString('base64')}`;
}

describe('phoneThumbnail', () => {
  it('shrinks a photo to a small JPEG, keeping its shape', async () => {
    const t = await phoneThumbnail(await photo(1600, 900));
    expect(t.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(PHONE_SESSION_VIEW.thumbChars);
    const back = await Jimp.read(Buffer.from(t.split(',')[1], 'base64'));
    expect([back.width, back.height]).toEqual([PHONE_SESSION_VIEW.thumbSide, 216]);
  });

  it('never enlarges, and gives the same answer from its cache', async () => {
    const p = await photo(40, 30);
    const a = await phoneThumbnail(p);
    const back = await Jimp.read(Buffer.from(a.split(',')[1], 'base64'));
    expect([back.width, back.height]).toEqual([40, 30]);
    expect(await phoneThumbnail(p)).toBe(a);
  });

  it("is '' for anything it can't read", async () => {
    expect(await phoneThumbnail('data:image/png;base64,bm90IGFuIGltYWdl')).toBe('');
    expect(await phoneThumbnail('data:text/plain;base64,aGk=')).toBe('');
    expect(await phoneThumbnail('https://example.com/a.png')).toBe('');
  });
});
