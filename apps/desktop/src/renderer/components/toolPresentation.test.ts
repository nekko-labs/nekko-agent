import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TOOL_LABELS, toolMatchesQuery, toolPickerLabel } from './toolPresentation.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));
const { ToolsList } = await import('./ChatControls.js');

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('tool picker presentation', () => {
  it('covers every built-in tool without changing identifiers', () => {
    // The engine's tool catalog (nekko-turn), every tool a turn can offer.
    const catalog = JSON.parse(read('../../../../../crates/nekko-turn/src/catalog.json')).tools;
    const names: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const { name } = v as { name?: unknown };
        if (typeof name === 'string') names.push(name);
        Object.values(v).forEach(walk);
      }
    };
    walk(catalog);
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
  const tools = [
    { name: 'grep', description: 'Match a regular expression across the project, with a long description that must wrap rather than be cut off.' },
    { name: 'web_fetch', description: 'Fetch a page.' },
    { name: 'mcp__srv__find', description: 'Find things.' },
  ];
  const session = (patch: object = {}) => ({ id: 's', title: 'Chat', messages: [], createdAt: 0, updatedAt: 0, ...patch }) as never;
  const list = (patch: object = {}) => renderToStaticMarkup(React.createElement(ToolsList, { session: session(patch), onChange: () => {}, tools }));

  it('lists tools as native buttons with checkbox semantics and untruncated descriptions', () => {
    const html = list({ disabledTools: ['grep'] });
    const rows = [...html.matchAll(/<button[^>]*data-tool-name="([^"]+)"[^>]*>/g)];
    expect(rows.map((m) => m[1]).sort()).toEqual(['grep', 'mcp__srv__find', 'web_fetch']);
    for (const [tag] of rows) {
      expect(tag).toContain('role="menuitemcheckbox"');
      expect(tag).toMatch(/focus-visible:outline-2/);
    }
    expect(rows.find((m) => m[1] === 'grep')![0]).toContain('aria-checked="false"');
    expect(rows.find((m) => m[1] === 'web_fetch')![0]).toContain('aria-checked="true"');
    // The full description is there, wrapping, never truncated; the tick box is decoration.
    expect(html).toMatch(/<span class="[^"]*whitespace-normal[^"]*">Match a regular expression across the project, with a long description that must wrap rather than be cut off\.<\/span>/);
    expect(html).not.toMatch(/class="[^"]*\btruncate\b[^"]*">Match a regular/);
    expect(html).toMatch(/<span aria-hidden="true" class="mt-0\.5 inline-flex/);
  });

  it('disables only the tools that need the internet while it is blocked', () => {
    const html = list({ offline: true });
    const tag = (name: string) => html.match(new RegExp(`<button[^>]*data-tool-name="${name}"[^>]*>`))![0];
    expect(tag('web_fetch')).toContain('disabled=""');
    expect(tag('grep')).not.toContain('disabled=""');
  });

  it('offers only file and shell tools in a sandbox', () => {
    const html = renderToStaticMarkup(React.createElement(ToolsList, {
      session: session({ executionMode: 'sandbox' }), onChange: () => {},
      tools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'web_fetch', 'browser'].map((name) => ({ name, description: name })),
    }));
    expect([...html.matchAll(/data-tool-name="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(['bash', 'edit_file', 'glob', 'grep', 'list_dir', 'read_file', 'write_file']);
  });

  // Source pins: the menu's popover width and the toggle's write run on click,
  // in a portal, which a server render never reaches.
  it('opens a 448px popover and saves a toggle as the chat\'s disabled tools (source pin)', () => {
    const source = read('./ChatControls.tsx');
    expect(source).toMatch(/useFloatingMenu\(open, button, 448\)/);
    expect(source).toMatch(/onChange\(await window\.nekko\.setSessionOptions\(session\.id, \{ disabledTools: \[\.\.\.next\] \}/);
  });
});
