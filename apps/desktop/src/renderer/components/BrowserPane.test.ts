import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { (globalThis as { location?: unknown }).location = { origin: 'http://localhost:1440' }; });
import { normalizeUrl } from './BrowserPane.js';

describe('browser pane addresses', () => {
  it('opens http(s), local dev servers and bare domains', () => {
    expect(normalizeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeUrl('127.0.0.1:5173/x')).toBe('http://127.0.0.1:5173/x');
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('two words')).toBe('https://duckduckgo.com/?q=two%20words');
  });
  it('never hands the frame a script, file or data URL, or the app itself', () => {
    for (const bad of ['javascript:alert(1)', 'javascript://%0aalert(1)', 'JavaScript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<script>1</script>', 'http://localhost:1440/']) {
      expect(normalizeUrl(bad)).toBe('about:blank');
    }
  });
});
