import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_LABELS, toolMatchesQuery, toolPickerLabel } from './toolPresentation.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('tool picker presentation', () => {
  it('covers every built-in core and host tool without changing identifiers', () => {
    const sources = [read('../../../../../packages/core/src/agent/tools.ts'), read('../../../../../packages/host/src/agent-watches.ts'), read('../../../../../packages/host/src/host.ts')];
    const names = sources.flatMap((s) => [...s.matchAll(/^\s*name: '([a-z_]+)',/gm)].map((m) => m[1]));
    expect(names).toContain('grep');
    for (const name of names) expect(TOOL_LABELS[name], name).toBeTruthy();
  });
  it('distinguishes content search from finding filenames', () => {
    expect(toolPickerLabel('grep')).toBe('Search file contents');
    expect(toolPickerLabel('glob')).toBe('Find files');
  });
  it('humanizes unknown and MCP tools without hiding server identity', () => {
    expect(toolPickerLabel('customHTTPTool')).toBe('Custom HTTPTool');
    expect(toolPickerLabel('future_tool-name')).toBe('Future tool name');
    expect(toolPickerLabel('mcp__my_server__search_issues')).toBe('Search issues (My server)');
    expect(toolPickerLabel('mcp__')).toBe('Unnamed tool (MCP)');
    expect(toolPickerLabel('')).toBe('Unnamed tool');
  });
  it('searches friendly labels, literal identifiers and full descriptions', () => {
    const tool = { name: 'grep', description: 'Match a regular expression across the project.' };
    for (const q of [' SEARCH FILE CONTENTS ', 'grep', 'regular expression', '']) expect(toolMatchesQuery(tool, q)).toBe(true);
    expect(toolMatchesQuery(tool, 'filenames')).toBe(false);
    expect(toolMatchesQuery({ name: 'mcp__server__find_issues', description: '' }, 'Find issues')).toBe(true);
  });
  it('keeps native keyboard activation, checkbox semantics and untruncated descriptions', () => {
    const source = read('./ChatControls.tsx');
    expect(source).toContain('useFloatingMenu(open, button, 448)');
    expect(source).toContain('role="menuitemcheckbox" aria-checked={on}');
    expect(source).toContain('disabled={blocked}');
    expect(source).toContain('aria-hidden="true" className="mt-0.5 inline-flex');
    expect(source).toContain('focus-visible:outline-2');
    expect(source).toContain('whitespace-normal text-[11px] leading-relaxed');
    expect(source).not.toContain('block truncate text-[11px] text-ink-faint">{t.description}');
    expect(source).toContain("['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash']");
    expect(source).toContain('onChange(await window.nekko.setSessionOptions(session.id, { disabledTools: [...next] }');
  });
});
