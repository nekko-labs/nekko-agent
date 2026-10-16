import { describe, expect, it } from 'vitest';
import { hasUserMedia, videoParts, withVideoNote } from './media.js';

const clip = 'data:video/mp4;base64,AAAA';

describe('video attachments on the wire', () => {
  it('lays out video_url parts for OpenAI-compatible servers', () => {
    expect(videoParts({ id: 'u', role: 'user', content: 'look', createdAt: 0, videos: [clip] }))
      .toEqual([{ type: 'video_url', video_url: { url: clip } }]);
    expect(videoParts({ id: 'u', role: 'user', content: 'look', createdAt: 0 })).toEqual([]);
  });

  it('replaces videos with a note for providers that cannot carry them', () => {
    expect(withVideoNote({ id: 'u', role: 'user', content: 'look', createdAt: 0, videos: [clip, clip] }))
      .toBe('look\n\n[2 video attachments omitted: this model does not accept video input. Tell the user if the videos matter to the task.]');
    expect(withVideoNote({ id: 'u', role: 'user', content: '', createdAt: 0, videos: [clip] })).toMatch(/^\[1 video attachment omitted/);
    expect(withVideoNote({ id: 'u', role: 'user', content: 'plain', createdAt: 0 })).toBe('plain');
  });

  it('knows which user turns need content parts', () => {
    expect(hasUserMedia({ id: 'u', role: 'user', content: '', createdAt: 0, videos: [clip] })).toBe(true);
    expect(hasUserMedia({ id: 'u', role: 'user', content: '', createdAt: 0, images: ['data:image/png;base64,x'] })).toBe(true);
    expect(hasUserMedia({ id: 'a', role: 'assistant', content: '', createdAt: 0, images: ['x'] })).toBe(false);
    expect(hasUserMedia({ id: 'u', role: 'user', content: 'hi', createdAt: 0 })).toBe(false);
  });
});
