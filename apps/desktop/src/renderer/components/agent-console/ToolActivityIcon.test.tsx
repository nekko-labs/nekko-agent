import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolActivityIcon, toolIconKind, purposeIconKind } from './ToolActivityIcon.js';
import { ReplyActivityIcon } from './ReplyStatus.js';
import { ActivityGroup } from './ActivityGroup.js';
import '../../tests/browserGlobals.js';

describe('tool activity icons', () => {
  it.each([
    ['read_file', { path: 'src/a.ts' }, 'read'], ['functions.read_file', { path: 'AGENTS.md' }, 'read'],
    ['Read', { file_path: 'src/a.ts' }, 'read'], ['list_dir', {}, 'list'],
    ['grep', { pattern: 'test' }, 'search'], ['Glob', {}, 'search'],
    ['write_file', { path: 'src/a.py' }, 'edit'], ['Edit', {}, 'edit'], ['apply_patch', {}, 'edit'],
    ['bash', { command: 'python3 report.py' }, 'terminal'], ['functions.bash', { command: 'python3 -c "print(1)"' }, 'terminal'],
    ['Bash', { command: 'npm test' }, 'check'], ['bash', { command: 'git status' }, 'git'],
    ['start_process', { command: 'python report.py' }, 'terminal'], ['read_process', {}, 'terminal'],
    ['fetch_url', {}, 'web'], ['browser', {}, 'web'], ['update_plan', {}, 'plan'],
    ['unknown_tool', {}, 'other'], ['mcp__custom__read', {}, 'other'],
  ])('%s maps to %s', (name, input, expected) => {
    expect(toolIconKind({ name, input })).toBe(expected);
  });

  it.each(['read', 'search', 'list', 'edit', 'check', 'terminal', 'git', 'web', 'plan', 'other'] as const)('uses the primary accent by default for %s child icons', (kind) => {
    const html = renderToStaticMarkup(<ToolActivityIcon kind={kind} />);
    expect(html).toContain('text-accent');
    expect(html).not.toContain('text-ink-faint');
  });

  it('preserves an explicit icon color override', () => {
    const html = renderToStaticMarkup(<ToolActivityIcon kind="check" className="h-3 w-3 text-danger" />);
    expect(html).toContain('text-danger');
    expect(html).not.toContain('text-accent');
  });

  it('shows a common icon for homogeneous groups and purpose for mixed groups', () => {
    expect(purposeIconKind('explore', [{ name: 'read_file' }, { name: 'Read' }])).toBe('read');
    expect(purposeIconKind('explore', [{ name: 'read_file' }, { name: 'grep' }])).toBe('search');
    expect(purposeIconKind('guidance', [])).toBe('read');
    expect(purposeIconKind('run', [])).toBe('terminal');
    expect(purposeIconKind('other', [])).toBe('other');
  });

  it('shares the current-work terminal artwork, without animating transcript rows', () => {
    const live = renderToStaticMarkup(<ReplyActivityIcon state="terminal" size={12} />);
    const transcript = renderToStaticMarkup(<ToolActivityIcon kind="terminal" />);
    expect(live).toContain('reply-terminal-lines');
    expect(transcript).not.toContain('reply-terminal-lines');
    expect(transcript).toContain('data-part="reply-terminal"');
    const paths = (s: string) => [...s.matchAll(/ d="([^"]+)"/g)].map(m => m[1]);
    expect(paths(transcript)).toEqual(paths(live));
    expect(transcript).toContain('aria-hidden="true"');
    expect(transcript).toContain('focusable="false"');
  });

  it('renders specific icons in both the summary and individual call rows', () => {
    const html = renderToStaticMarkup(<ActivityGroup streaming items={[
      { kind: 'tool', call: { id: 'p', name: 'bash', input: { command: 'python3 report.py' } } },
      { kind: 'tool', call: { id: 'r', name: 'read_file', input: { path: 'report.txt' } } },
    ] as never} />);
    expect(html).toContain('data-tool-icon="terminal"');
    expect(html.match(/data-tool-icon="read"/g)).toHaveLength(2);
  });
});
