import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import type { ServedSite } from '@nekko-agent/shared';
import { liveHook, liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { useStore } from '../store.js';
import { useWallLogs } from '../wallLogs.js';
import { AGENT_PANEL_SHOWS_KEY } from './agentPanelView.js';
import { DEFAULT_WALL_STATE, loadWallState, openWallPane, saveWallState } from '../commandWall.js';

// Browsers and Files open without an agent (#2824).

let sites: ServedSite[] | null = null;
vi.mock('../servedSites.js', () => ({ useServedSites: (active: boolean) => (active ? sites : null) }));
vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../wallLogs.js', (original) => liveHook('useWallLogs')(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const open = () => {};
const app = { id: 'app', name: 'shop', path: '/code/shop', addedAt: 0, repo: { provider: 'github' as const, fullName: 'acme/shop' } };
const notes = { id: 'notes', name: 'notes', path: '/Users/me/notes', addedAt: 0 };

beforeEach(() => {
  sites = null;
  useStore.setState({ terminals: [], workspaces: [] });
  useWallLogs.setState({ sessionId: null, kind: 'logs', closing: false });
  localStorage.removeItem(AGENT_PANEL_SHOWS_KEY);
});

describe('Browsers without an agent', () => {
  it('lists the pages served here, named by title and tagged with the folder they run from', () => {
    sites = [
      { url: 'http://localhost:5173/', port: 5173, title: 'Shop admin', process: 'node', cwd: '/code/shop/web' },
      { url: 'http://localhost:8000/', port: 8000, process: 'python3', cwd: '/tmp' },
    ];
    const html = renderSidebar({ sessions: [], shows: 'browsers', settings: { workspaces: [app, notes] }, onOpenWindow: open });
    expect(html).toMatch(/data-served-site="5173"[^]*Shop admin[^]*shop<\/span>/);
    // No title: the address; no connected folder: the port.
    expect(html).toMatch(/data-served-site="8000"[^]*localhost:8000[^]*:8000<\/span>/);
    expect(html).toContain('data-blank-browser');
    // With no agents there is nothing to say about them.
    expect(html).not.toContain('No agents to open a browser beside');
    expect(html).not.toContain('data-companion-heading');
  });

  it('says when nothing is served, and still offers a blank browser', () => {
    sites = [];
    const html = renderSidebar({ sessions: [], shows: 'browsers', onOpenWindow: open });
    expect(html).toContain('No pages served on this computer');
    expect(html).toContain('data-blank-browser');
  });

  it('keeps the agents below their own heading', () => {
    sites = [];
    const html = renderSidebar({ sessions: [agentSummary('chat', { title: 'Fix login' })], shows: 'browsers', onOpenWindow: open });
    expect(html).toMatch(/data-blank-browser[^]*data-companion-heading[^]*data-companion-row="chat"/);
  });
});

describe('Files without an agent', () => {
  it('lists the connected folders, repositories with their name', () => {
    const html = renderSidebar({ sessions: [], shows: 'files', settings: { workspaces: [app, notes] }, onOpenWindow: open });
    expect(html).toMatch(/data-connected-folder="app"[^]*shop[^]*acme\/shop/);
    expect(html).toContain('data-connected-folder="notes"');
    expect(html).toContain('title="Browse /Users/me/notes"');
    expect(html).not.toContain('No agents whose files to browse');
  });

  it('says when no folder is connected', () => {
    expect(renderSidebar({ sessions: [], shows: 'files', settings: { workspaces: [] }, onOpenWindow: open })).toContain('No folders connected');
  });
});

describe('a Browser or Files window on the wall', () => {
  it('opens into the active zone, once, and survives a reload', () => {
    const wall = openWallPane(DEFAULT_WALL_STATE, 'browser', 'http://localhost:5173/');
    // Asking again only shows the one already there.
    expect(openWallPane(wall, 'browser', 'http://localhost:5173/')).toBe(wall);
    const files = openWallPane(wall, 'files', '/code/shop');
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
    for (const [state, want] of [[wall, 'browser:http://localhost:5173/'], [files, 'files:/code/shop']] as const) {
      saveWallState(storage, state);
      const root = loadWallState(storage).root as { kind?: string; refId?: string } | null;
      expect(`${root?.kind}:${root?.refId}`).toBe(want);
    }
  });
});
