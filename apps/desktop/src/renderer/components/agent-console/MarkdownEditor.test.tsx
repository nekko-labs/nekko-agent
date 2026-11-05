import { describe, expect, it } from 'vitest';
import { markdownEdit } from './MarkdownEditor.js';

const newline = (text: string) => markdownEdit(text, text.length, text.length, 'Enter', true);

describe('markdown editing', () => {
  it('continues bullets and preserves indentation', () => {
    expect(newline('  - first')?.text).toBe('  - first\n  - ');
    expect(newline('* first')?.text).toBe('* first\n* ');
  });
  it('increments ordered lists and resets task checkboxes', () => {
    expect(newline('9. item')?.text).toBe('9. item\n10. ');
    expect(newline('- [x] done')?.text).toBe('- [x] done\n- [ ] ');
  });
  it('exits empty lists and quotes', () => {
    expect(newline('item\n- ')?.text).toBe('item\n');
    expect(newline('> ')?.text).toBe('');
    expect(newline('- [ ] ')?.text).toBe('');
  });
  it('continues quotes but not markdown inside code fences', () => {
    expect(newline('> quote')?.text).toBe('> quote\n> ');
    expect(newline('```\n- code')?.text).toBe('```\n- code\n');
  });
  it('keeps single-backtick code lines out of list and quote editing', () => {
    expect(newline('`\n- code')?.text).toBe('`\n- code\n');
    expect(newline('`\n  > code')?.text).toBe('`\n  > code\n  ');
    const text = '`\n- code';
    expect(markdownEdit(text, text.length, text.length, 'Tab')).toBeNull();
    expect(newline('`\ncode\n`\n- list')?.text).toBe('`\ncode\n`\n- list\n- ');
  });
  it('does not let mixed fence markers change code editing state', () => {
    expect(newline('`\n```\n- code')?.text).toBe('`\n```\n- code\n');
    expect(newline('```\n`\n- code')?.text).toBe('```\n`\n- code\n');
    expect(newline('run `code`\n- list')?.text).toBe('run `code`\n- list\n- ');
  });
  it('leaves fenced raw text intact for the send handler', () => {
    const text = '`\nconst html = "<script>alert(1)</script>";\n`';
    expect(markdownEdit(text, text.length, text.length, 'Enter')).toBeNull();
  });
  it('wraps and unwraps selections with shortcuts', () => {
    expect(markdownEdit('hello', 0, 5, 'b', false, true)).toEqual({ text: '**hello**', start: 2, end: 7 });
    expect(markdownEdit('**hello**', 2, 7, 'b', false, true)).toEqual({ text: 'hello', start: 0, end: 5 });
    expect(markdownEdit('', 0, 0, 'e', false, true)).toEqual({ text: '``', start: 1, end: 1 });
  });
  it('indents and outdents list items without trapping Tab elsewhere', () => {
    expect(markdownEdit('- item', 6, 6, 'Tab')?.text).toBe('  - item');
    expect(markdownEdit('  - item', 8, 8, 'Tab', true)?.text).toBe('- item');
    expect(markdownEdit('text', 4, 4, 'Tab')).toBeNull();
  });
  it('leaves normal Enter to the send handler', () => {
    expect(markdownEdit('- item', 6, 6, 'Enter')).toBeNull();
  });
});
