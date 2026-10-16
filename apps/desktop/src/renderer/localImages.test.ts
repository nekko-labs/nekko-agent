import { describe, expect, it } from 'vitest';
import { localImageData, localImagePath } from './localImages.js';
import { chatArtifacts } from './chatArtifacts.js';
import { sessionArtifacts } from './artifactsIndex.js';

const file = { content: '', binary: false, truncated: false };
describe('local image boundaries', () => {
  it.each(['https://x/a.svg', '//server/a.png', '\\\\server\\a.svg', '\\root\\a.png', 'file:///a.png', 'data:image/png;base64,AA', 'javascript:a.svg', 'C:/a.png:stream', 'C:/a\n.png'])('rejects non-local or unsafe path %s', src => {
    expect(localImagePath(src, 'C:/project')).toBeNull();
  });
  it('normalizes local paths without losing roots and rejects network bases', () => {
    expect(localImagePath('../out/a.svg', 'C:/project/docs')).toBe('C:/project/out/a.svg');
    expect(localImagePath('../../a.png', '/project')).toBe('/a.png');
    expect(localImagePath('a.png')).toBeNull();
    expect(localImagePath('a.png', '\\\\server\\share')).toBeNull();
  });
  it('encodes SVG as inert image data, not an app document', () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://x/a.png"/></svg>';
    const data = localImageData('/a.svg', { ...file, content });
    expect(data).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`);
    expect(data).not.toContain('<svg');
    expect(localImageData('/a.svg', { ...file, content, truncated: true })).toBeNull();
    expect(localImageData('/a.svg', { ...file, content, binary: true })).toBeNull();
  });
  it('accepts only supported raster data URLs from host and rejects truncated results', () => {
    expect(localImageData('/a.png', { ...file, imageDataUrl: 'data:image/png;base64,AAAA' })).toBe('data:image/png;base64,AAAA');
    for (const imageDataUrl of ['https://x/a.png', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA']) {
      expect(localImageData('/a.png', { ...file, imageDataUrl })).toBeNull();
    }
    expect(localImageData('/a.png', { ...file, truncated: true, imageDataUrl: 'data:image/png;base64,AAAA' })).toBeNull();
  });
  it('indexes both markdown images and explicit links once, marking inline duplicates', () => {
    const content = '[Source](out/a.svg) ![Diagram](./out/a.svg) ![](out/b.PNG) [Photo](out/c.jpeg)';
    const artifacts = chatArtifacts(content, 'C:/project');
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toMatchObject({ path: 'C:/project/out/a.svg', inlineImage: true });
    expect(artifacts.filter(a => !a.inlineImage).map(a => a.filename)).toEqual(['c.jpeg']);
    const entries = sessionArtifacts({ id: 's', title: 'Images', messages: [{ id: 'm', role: 'assistant', content, createdAt: 1 }] }, 'C:/project');
    expect(entries.map(a => a.kind)).toEqual(['image', 'image', 'image']);
  });
});
