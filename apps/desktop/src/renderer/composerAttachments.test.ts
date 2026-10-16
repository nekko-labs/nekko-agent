import { describe, expect, it } from 'vitest';
import { attachmentName, pastedFileName, planAttachment, unreadableNote } from './composerAttachments.js';

const sighted = { image: 'yes', video: 'yes' } as const;
const blind = { image: 'no', video: 'no' } as const;
const unsure = { image: 'unknown', video: 'unknown' } as const;

describe('planAttachment', () => {
  it('carries photos and videos inline when the model can see them', () => {
    const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    const mp4 = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
    expect(planAttachment(png, '', sighted)).toEqual({ kind: 'image', file: png });
    expect(planAttachment(mp4, '', sighted)).toEqual({ kind: 'video', file: mp4 });
    // Unknown support lets the attachment through rather than blocking the user.
    expect(planAttachment(png, '', unsure).kind).toBe('image');
  });

  it('keeps a photo as a flagged file when the model is text-only', () => {
    const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    expect(planAttachment(png, 'C:/shots/shot.png', blind)).toEqual({ kind: 'path', path: 'C:/shots/shot.png', note: "Attached as a file: this model can't view photos" });
    expect(planAttachment(png, '', blind)).toMatchObject({ kind: 'import', note: "Attached as a file: this model can't view photos" });
  });

  it('attaches other files by path when the OS says where they live, else imports them', () => {
    const md = new File(['# hi'], 'notes.md', { type: 'text/markdown' });
    expect(planAttachment(md, '/home/p/notes.md', sighted)).toEqual({ kind: 'path', path: '/home/p/notes.md', note: undefined });
    const pdf = new File([new Uint8Array([1])], 'paper.pdf', { type: 'application/pdf' });
    expect(planAttachment(pdf, '', sighted)).toMatchObject({ kind: 'import', note: expect.stringContaining('PDF') });
  });
});

describe('unreadableNote', () => {
  it('flags what the model will not read, and stays quiet for text', () => {
    expect(unreadableNote('a.md')).toBeNull();
    expect(unreadableNote('Makefile')).toBeNull();
    expect(unreadableNote('a.docx')).toContain('Office');
    expect(unreadableNote('a.zip')).toContain('Binary');
    expect(unreadableNote('a.mp3')).toContain('Audio');
    expect(unreadableNote('a.png', 'image/png')).toBeNull();
  });
});

describe('names', () => {
  it('names a nameless paste by time and type, and keeps a real name', () => {
    const at = new Date('2026-10-13T10:20:30.000Z');
    expect(pastedFileName(new File([''], 'image.png', { type: 'image/png' }), at)).toBe('pasted-2026-10-13T10-20-30.png');
    expect(pastedFileName(new File([''], '', { type: 'image/jpeg' }), at)).toBe('pasted-2026-10-13T10-20-30.jpg');
    expect(pastedFileName(new File([''], 'report.pdf', { type: 'application/pdf' }), at)).toBe('report.pdf');
    expect(attachmentName('C:\\a\\b\\c.txt')).toBe('c.txt');
    expect(attachmentName('/x/y.md')).toBe('y.md');
  });
});
