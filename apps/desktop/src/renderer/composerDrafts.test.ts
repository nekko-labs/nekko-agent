import { beforeEach, describe, expect, it } from 'vitest';

class FakeStorage {
  map = new Map<string, string>();
  limit = Infinity;
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (v.length > this.limit) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(k, v);
  }
}

const storage = new FakeStorage();
(globalThis as any).window = { localStorage: storage };

const { loadDraft, saveDraft, clearDraft } = await import('./composerDrafts.js');

describe('composerDrafts', () => {
  beforeEach(() => { storage.map.clear(); storage.limit = Infinity; });

  it('round-trips text and images', () => {
    saveDraft('a', { text: 'hello', images: ['data:image/png;base64,AAA'] });
    expect(loadDraft('a')).toMatchObject({ text: 'hello', images: ['data:image/png;base64,AAA'] });
  });

  it('keeps drafts separate per chat', () => {
    saveDraft('a', { text: 'for a', images: [] });
    saveDraft('b', { text: 'for b', images: [] });
    expect(loadDraft('a')?.text).toBe('for a');
    expect(loadDraft('b')?.text).toBe('for b');
  });

  it('drops the entry when the draft goes empty', () => {
    saveDraft('a', { text: 'hi', images: [] });
    saveDraft('a', { text: '   ', images: [] });
    expect(loadDraft('a')).toBeNull();
    saveDraft('a', { text: 'hi', images: [] });
    clearDraft('a');
    expect(loadDraft('a')).toBeNull();
  });

  it('keeps an images-only draft', () => {
    saveDraft('a', { text: '', images: ['img'] });
    expect(loadDraft('a')?.images).toEqual(['img']);
  });

  it('keeps files attached since the last send, and forgets them once sent', () => {
    saveDraft('a', { text: '', images: [], paths: ['/tmp/notes.txt'] });
    expect(loadDraft('a')?.paths).toEqual(['/tmp/notes.txt']);
    saveDraft('a', { text: 'hi', images: [] });
    expect(loadDraft('a')?.paths).toEqual([]);
    clearDraft('a');
    expect(loadDraft('a')).toBeNull();
  });

  it('evicts other chats oldest-first when storage is full', () => {
    storage.limit = 400;
    saveDraft('old', { text: 'x'.repeat(120), images: [] });
    saveDraft('mid', { text: 'y'.repeat(120), images: [] });
    saveDraft('new', { text: 'z'.repeat(120), images: [] });
    expect(loadDraft('new')?.text).toBe('z'.repeat(120));
    expect(loadDraft('old')).toBeNull();
  });

  it("drops other chats' pictures before anyone's words", () => {
    storage.limit = 600;
    saveDraft('older', { text: 'typed words', images: ['p'.repeat(300)] });
    saveDraft('newer', { text: 'n'.repeat(250), images: [] });
    // The older chat lost its picture, not its text.
    expect(loadDraft('older')?.text).toBe('typed words');
    expect(loadDraft('older')?.images).toEqual([]);
    expect(loadDraft('newer')?.text).toBe('n'.repeat(250));
  });

  it('keeps the text and drops the images when a lone draft cannot fit', () => {
    storage.limit = 200;
    saveDraft('a', { text: 'precious words', images: ['x'.repeat(5000)] });
    expect(loadDraft('a')?.text).toBe('precious words');
    expect(loadDraft('a')?.images).toEqual([]);
  });

  it('survives corrupt stored json', () => {
    storage.map.set('nekko.composerDrafts', '{not json');
    expect(loadDraft('a')).toBeNull();
    saveDraft('a', { text: 'fresh', images: [] });
    expect(loadDraft('a')?.text).toBe('fresh');
  });
});
