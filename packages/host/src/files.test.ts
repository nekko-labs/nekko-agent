import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, sep } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { importAttachment, readFile } from './files.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(name: string, data: Buffer | string) {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-image-')); dirs.push(dir);
  const path = join(dir, name); writeFileSync(path, data); return path;
}
describe('explicit file image previews', () => {
  it('returns a bounded raster data URL with verified PNG signature', () => {
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    expect(readFile(fixture('shot.png', data)).imageDataUrl).toBe(`data:image/png;base64,${data.toString('base64')}`);
  });
  it('does not trust extensions or inline SVG as raster data', () => {
    expect(readFile(fixture('fake.png', '<script>alert(1)</script>')).imageDataUrl).toBeUndefined();
    expect(readFile(fixture('image.svg', '<svg/>')).imageDataUrl).toBeUndefined();
  });
  it('rejects oversized images before encoding', () => {
    const result = readFile(fixture('large.png', Buffer.alloc(8_000_001)));
    expect(result.truncated).toBe(true); expect(result.imageDataUrl).toBeUndefined();
  });
});

describe('pasted attachment import', () => {
  it('saves the bytes under the chat, with a safe name, and never overwrites', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nekko-attach-')); dirs.push(dataDir);
    const url = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 hello').toString('base64')}`;
    const first = importAttachment(dataDir, 'sess/1', '../evil:name?.pdf', url);
    expect(first.startsWith(join(dataDir, 'attachments', 'sess_1') + sep)).toBe(true);
    expect(basename(first)).toBe('evil_name_.pdf');
    expect(readFileSync(first, 'utf8')).toBe('%PDF-1.4 hello');
    const second = importAttachment(dataDir, 'sess/1', 'evil_name_.pdf', url);
    expect(basename(second)).toBe('evil_name_-2.pdf');
    expect(existsSync(first)).toBe(true);
  });
  it('refuses anything that is not a base64 data URL', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nekko-attach-')); dirs.push(dataDir);
    expect(() => importAttachment(dataDir, 's', 'a.txt', 'hello')).toThrow(/base64/);
    expect(() => importAttachment(dataDir, 's', 'a.txt', 'data:text/plain,hello')).toThrow(/base64/);
  });
});
