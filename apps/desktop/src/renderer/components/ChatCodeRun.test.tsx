import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, MarkdownSandbox } from './Markdown.js';
import { ChatCodeRun, type ChatCodeRunTarget } from './ChatCodeRun.js';

const target: ChatCodeRunTarget = { sessionId: 's1', cwd: '/code/app' };
const reply = 'Run this:\n\n```bash\nnpm ci\n```\n\nand this is code:\n\n```ts\nconst a = 1;\n```\n';
const render = (node: React.ReactNode, run: ChatCodeRunTarget | null = target) =>
  renderToStaticMarkup(<ChatCodeRun.Provider value={run}>{node}</ChatCodeRun.Provider>);
const runs = (html: string) => html.match(/data-run-command/g)?.length ?? 0;

describe('Run on a suggested command (#2595)', () => {
  it('shows on the shell blocks of an agent reply in a chat that may run commands', () => {
    const html = render(<Markdown text={reply} runnable />);
    expect(runs(html)).toBe(1);
    expect(html).toContain("Run in this chat&#x27;s terminal");
    // Copy stays on every block.
    expect(html.match(/Copy code/g)?.length).toBe(2);
  });

  it('is not offered on your own messages, outside a chat, or in a Sandbox chat', () => {
    expect(runs(render(<Markdown text={reply} />))).toBe(0);
    expect(runs(render(<Markdown text={reply} runnable />, null))).toBe(0);
    expect(runs(render(<MarkdownSandbox.Provider value><Markdown text={reply} runnable /></MarkdownSandbox.Provider>))).toBe(0);
  });

  it('waits for a fence that is still being written', () => {
    expect(runs(render(<Markdown text={'Run this:\n\n```bash\nnpm c'} runnable />))).toBe(0);
    expect(runs(render(<Markdown text={'```bash\nnpm ci\n```\n\n```bash\nnpm t'} runnable />))).toBe(1);
  });

  it('counts the lines a multi-line block will run', () => {
    expect(render(<Markdown text={'```sh\nnpm ci\nnpm test\n```'} runnable />)).toContain('Run these 2 lines');
  });

  it('offers nothing for a block with nothing to run', () => {
    expect(runs(render(<Markdown text={'```console\n# just a note\n```'} runnable />))).toBe(0);
  });
});
