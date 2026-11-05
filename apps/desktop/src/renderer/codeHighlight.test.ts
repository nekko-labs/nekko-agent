import { describe, expect, it } from 'vitest';
import { detectLanguage, highlightHtml, languageName, loadHighlighter } from './codeHighlight.js';

describe('code highlighting', () => {
  it('recognises languages by extension, file name and contents', async () => {
    const hljs = await loadHighlighter();
    const cases: Array<[string, string, string | null]> = [
      ['C:\\repo\\completionExit.ts', '', 'ts'],
      ['/src/App.tsx', '', 'tsx'],
      ['main.rs', '', 'rs'],
      ['script.py', '', 'py'],
      ['go.mod', '', null],
      ['styles.css', '', 'css'],
      ['Cargo.toml', '', 'toml'],
      ['config.yml', '', 'yml'],
      ['setup.ps1', '', 'ps1'],
      ['Component.vue', '', 'xml'],
      ['tsconfig.jsonc', '', 'json'],
      ['Dockerfile', '', 'dockerfile'],
      ['Makefile', '', 'makefile'],
      ['.env.local', '', 'bash'],
      ['notes.txt', 'just words', null],
      ['run', '#!/usr/bin/env python3\nprint(1)\n', 'python'],
    ];
    for (const [path, content, want] of cases) expect(detectLanguage(hljs, path, content), path).toBe(want);
    expect(languageName(hljs, 'ts')).toBe('TypeScript');
    expect(languageName(hljs, null)).toBe('Plain text');
  });

  it('sniffs an extensionless file and leaves prose plain', async () => {
    const hljs = await loadHighlighter();
    const json = '{\n  "name": "nekko",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "build": "tsc" }\n}\n';
    expect(detectLanguage(hljs, 'LICENSE', 'Permission is hereby granted, free of charge, to any person.')).toBeNull();
    expect(detectLanguage(hljs, 'data', json)).toBe('json');
  });

  it('escapes the source while wrapping tokens', async () => {
    const hljs = await loadHighlighter();
    const html = highlightHtml(hljs, 'const a = "<b>";', 'ts');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});
