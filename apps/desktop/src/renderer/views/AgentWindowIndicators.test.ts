import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));
const { statusFromEvent } = await import('./WorkspacesView.js');

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('agent status from events', () => {
  it('shows needs-input for a question as well as an approval', () => {
    expect(statusFromEvent('question')).toBe('input');
    expect(statusFromEvent('tool_approval_required')).toBe('input');
  });
  it('keeps the ? while a parked turn streams, and clears it when answered', () => {
    expect(statusFromEvent('text', 'input')).toBeUndefined();
    expect(statusFromEvent('step', 'input')).toBeUndefined();
    expect(statusFromEvent('question_resolved', 'input')).toBe('working');
    expect(statusFromEvent('tool_result', 'input')).toBe('working');
    expect(statusFromEvent('text')).toBe('working');
    expect(statusFromEvent('done', 'input')).toBeNull();
    expect(statusFromEvent('error')).toBe('error');
  });
  it('seeds waiting chats from the host on mount', () => {
    expect(read('./WorkspacesView.tsx')).toMatch(/window\.nekko\.pendingInput\(\)\.then\(\(pending\) => setStatuses/);
  });
});

describe('agent window indicators', () => {
  const wall = read('../components/CommandWall.tsx');
  const pane = read('../components/ChatPane.tsx');
  const controls = read('../components/ChatControls.tsx');
  const css = read('../styles.css');
  it('wears the warm attention ring when waiting on you', () => {
    expect(wall).toContain('data-wall-needs-you={needsYou || undefined}');
    expect(css).toMatch(/\.command-wall-window\[data-wall-needs-you\] > \.panel[\s\S]{0,200}--panel-ring-color: var\(--warning\) !important/);
  });
  it('draws the activity glyph before the agent icon in the title strip', () => {
    expect(wall).toContain("status={agentStatus ?? 'idle'}");
    expect(wall).toContain('statusIndicator={session ? undefined');
    expect(wall).toContain('<span data-agent-status><StatusIcon status={agentStatus} /></span><NumberedAgentIcon');
    expect(pane).not.toContain('agent-footer-status');
  });
  it('replaces the Online label with an internet toggle and moves Tools and MCP to the footer', () => {
    expect(pane).not.toContain("{session?.offline ? 'Offline' : 'Online'}");
    expect(pane).toContain('<InternetToggle session={session}');
    expect(pane).toMatch(/data-agent-footer-controls>[\s\S]{0,200}<ToolsMenu[\s\S]{0,200}<McpMenu \/>/);
    expect(controls).toContain('Click to block internet connectivity.');
    expect(controls).toContain('Click to allow internet connectivity.');
    expect(pane).toMatch(/<ChatControls[\s\S]{0,140}toolsInWindow/);
    // A cloud model needs the internet: blocking stays local-only, as Offline was.
    expect(pane).toContain('<InternetToggle session={session} cloudModel={isCloudModel}');
    expect(controls).toContain('const locked = cloudModel && !blocked;');
    expect(controls).toContain('disabled={locked}');
  });
  it('drops the Continue work box from the wall composer', () => {
    expect(pane).toContain("{!imageMode && surface !== 'composer' && (canContinueReply || canContinueWork) && !streaming && (");
  });
});

describe('chat panel groups', () => {
  const view = read('./WorkspacesView.tsx');
  const css = read('../components/commandWallLayouts.css');
  it('hides a closed group\'s cards completely and keeps them out of the tab order', () => {
    expect(view).toContain('inert={isCollapsed || undefined}');
    expect(css).toContain('.agent-panel-row .collapse-wrap.collapsed { display: none; }');
    expect(css).toContain('[data-agent-panel] .collapse-wrap.collapsed { visibility: hidden; pointer-events: none; }');
  });
  it('turns the wheel into sideways scrolling in the row', () => {
    expect(view).toContain('onWheel={horizontal ? scrollRowWithWheel : undefined}');
  });
});
