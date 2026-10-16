import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ChatPane pulls in the whole chat surface, so the layout contract is checked
// on the source, as the other wall layout tests do.
const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
const wall = readFileSync(new URL('./WallComposer.tsx', import.meta.url), 'utf8');
const controls = readFileSync(new URL('./ChatControls.tsx', import.meta.url), 'utf8');

describe('wall composer layout', () => {
  it('has no bar above the composer: the agent row is the composer’s own first row', () => {
    expect(wall).not.toContain('<div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1 text-[12px]">');
    expect(wall).toContain('surface="composer" header={head}');
    expect(pane).toContain('data-composer-head');
    // Without an agent the same row stands alone over the empty state.
    expect(wall).toContain('{!agent && <div className="composer-head');
  });
  it('replaces the controls strip with that row, with Automate at its right end', () => {
    expect(pane).toContain('{showControls && !header && (<>');
    const head = pane.slice(pane.indexOf('data-composer-head'), pane.indexOf('{showControls && !header'));
    expect(head).toContain('{header}');
    expect(head).toContain('Automate');
  });
  it('puts mode and incognito in the bottom bar beside +', () => {
    const foot = pane.slice(pane.indexOf('data-composer-foot') - 200, pane.indexOf('data-composer-foot') + 400);
    expect(foot).toContain('only="mode"');
    expect(foot).toContain('only="privacy"');
    expect(pane.indexOf('aria-label="Add a photo, video, file, folder, or skill"')).toBeLessThan(pane.indexOf('data-composer-foot'));
  });
  it('lets ChatControls render just the mode menu or just the privacy switch', () => {
    expect(controls).toContain("only?: 'mode' | 'privacy';");
    expect(controls).toContain("{session.chatType !== 'image' && showMode && (<>");
    expect(controls).toContain('{!toolsInWindow && !only && (sandbox ? <span title="MCP is unavailable in Sandbox">MCP unavailable</span> : <McpMenu />)}');
    expect(controls).toContain('{showPrivacy && <div');
  });
  it('drops the keyboard hint from the row into the title tooltip', () => {
    expect(wall).not.toContain("'Ctrl+Tab cycles windows · Ctrl+1…9 selects a window'");
    expect(wall).toContain('Ctrl+Tab cycles windows, Ctrl+1…9 selects one');
  });
});
