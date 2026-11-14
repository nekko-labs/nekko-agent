import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import type { TerminalInfo } from '@nekko-agent/shared';
import { cssRule, stylesheet } from '../tests/css.js';
import { liveHook, liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { useStore } from '../store.js';
import { useWallLogs } from '../wallLogs.js';
import { AGENT_PANEL_SHOWS, AGENT_PANEL_SHOWS_KEY, parseAgentPanelShows, readAgentPanelShows, saveAgentPanelShows } from './agentPanelView.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../wallLogs.js', (original) => liveHook('useWallLogs')(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const terminal = (id: string): TerminalInfo => ({ id, title: id, cwd: '/p', shell: '/bin/zsh', running: true, createdAt: 1 });
const chat = agentSummary('chat', { title: 'Fix login' });
const photo = agentSummary('photo', { title: 'Cat poster', chatType: 'image' });
const radios = (html: string) => [...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="(true|false)"[^>]*aria-label="([^"]+)"/g)].map((m) => [m[2], m[1] === 'true']);

beforeEach(() => {
  useStore.setState({ terminals: [terminal('t1')], workspaces: [] });
  useWallLogs.setState({ sessionId: null, kind: 'logs', closing: false });
  localStorage.removeItem(AGENT_PANEL_SHOWS_KEY);
});

describe('the Agents panel window-type switcher', () => {
  it('sits under the header as one sliding icon segment per window kind', () => {
    const html = renderSidebar({ sessions: [chat] });
    expect(html).toMatch(/data-agent-panel-header[^]*role="radiogroup" aria-label="Show windows" class="slide-toggle slide-toggle-icons agent-panel-shows[^]*data-agent-panel-list/);
    expect(radios(html)).toEqual([['Agents', true], ['Terminals', false], ['Photos and videos', false], ['Browsers', false], ['Files', false]]);
    // Gentleface icons, one per segment.
    for (const name of ['bots', 'terminal', 'image', 'globe', 'folder-open']) expect(html).toContain(`data-gf-icon="${name}"`);
    // The segments share the panel's width.
    const layout = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(layout, '.agent-panel-shows')).toMatchObject({ display: 'flex', width: '100%' });
    expect(cssRule(layout, '.agent-panel-shows.slide-toggle-icons button')).toMatchObject({ flex: '1 1 0', width: 'auto' });
  });

  it('lists only agent cards under Agents, and terminals and photo chats in their own views', () => {
    const sessions = [chat, photo];
    const agents = renderSidebar({ sessions });
    expect(agents).toContain('Fix login');
    expect(agents).not.toContain('Cat poster');
    expect(agents).not.toContain('data-terminal-row');

    const terminals = renderSidebar({ sessions, shows: 'terminals' });
    expect(terminals).toContain('data-terminal-row="t1"');
    expect(terminals).not.toContain('Fix login');
    expect(radios(terminals).find(([, on]) => on)?.[0]).toBe('Terminals');

    const media = renderSidebar({ sessions, shows: 'media' });
    expect(media).toContain('Cat poster');
    expect(media).not.toContain('Fix login');
    expect(media).not.toContain('data-terminal-row');
  });

  it('offers group, sort and show only for the agent cards', () => {
    expect(renderSidebar()).toContain('data-agent-view-button');
    for (const shows of ['terminals', 'media', 'browsers', 'files'] as const) expect(renderSidebar({ shows }), shows).not.toContain('data-agent-view-button');
  });

  it('lists each agent once under Browsers and Files, marking the one whose drawer is out', () => {
    const sessions = [chat, agentSummary('other', { title: 'Write docs' }), photo];
    useWallLogs.setState({ sessionId: 'chat', kind: 'browser', closing: false });
    const browsers = renderSidebar({ sessions, shows: 'browsers' });
    expect([...browsers.matchAll(/data-companion-row="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(['chat', 'other']);
    expect(browsers).toMatch(/data-companion-row="chat" aria-current="true"/);
    expect(browsers).not.toMatch(/data-companion-row="other" aria-current/);
    // The browser drawer being out does not mark the agent in Files.
    const files = renderSidebar({ sessions, shows: 'files' });
    expect(files).toContain('data-companion-row="chat"');
    expect(files).not.toContain('aria-current="true"');
    expect(files).toContain('Browse Fix login&#x27;s working folder');
  });

  it('says what is missing when a view is empty', () => {
    useStore.setState({ terminals: [] });
    expect(renderSidebar({ sessions: [chat], shows: 'terminals' })).toContain('No terminals open');
    expect(renderSidebar({ sessions: [chat], shows: 'media' })).toContain('No photo or video chats');
    expect(renderSidebar({ sessions: [], shows: 'browsers' })).toContain('No agents to open a browser beside');
  });

  it('remembers the pick and falls back to Agents for anything else', () => {
    expect(AGENT_PANEL_SHOWS.map((s) => s.id)).toEqual(['agents', 'terminals', 'media', 'browsers', 'files']);
    expect(readAgentPanelShows()).toBe('agents');
    saveAgentPanelShows('files');
    expect(readAgentPanelShows()).toBe('files');
    expect(parseAgentPanelShows('windows')).toBe('agents');
    expect(parseAgentPanelShows(null)).toBe('agents');
  });
});
