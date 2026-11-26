import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveHook, liveStore } from '../tests/liveStore.js';
import { agentSummary, renderSidebar } from '../tests/renderSidebar.js';
import { useStore } from '../store.js';
import { useWallLogs } from '../wallLogs.js';
import { AGENT_PANEL_SHOWS_KEY } from './agentPanelView.js';
import { baseName, folderOfFile } from './SidebarFileBrowser.js';
import { DEFAULT_WALL_STATE, loadWallState, openWallPane, saveWallState } from '../commandWall.js';

// The Agents panel's Files view is a file browser: the files open in the agent
// windows, then the connected folders as trees. A file opens, editable, in a
// window of its own.

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../wallLogs.js', (original) => liveHook('useWallLogs')(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));

const app = { id: 'app', name: 'shop', path: '/code/shop', addedAt: 0, repo: { provider: 'github' as const, fullName: 'acme/shop' } };
const web = { id: 'web', name: 'web', path: '/code/shop/web', addedAt: 0 };
const notes = { id: 'notes', name: 'notes', path: '/Users/me/notes', addedAt: 0 };

beforeEach(() => {
  useStore.setState({ terminals: [], workspaces: [] });
  useWallLogs.setState({ sessionId: null, kind: 'logs', closing: false });
  localStorage.removeItem(AGENT_PANEL_SHOWS_KEY);
});

describe('the Files view', () => {
  it('lists the connected folders as closed trees, repositories with their name', () => {
    const html = renderSidebar({ sessions: [], shows: 'files', settings: { workspaces: [app, notes] } });
    expect(html).toMatch(/data-connected-folder="app" aria-expanded="false"[^]*shop[^]*acme\/shop/);
    expect(html).toContain('data-connected-folder="notes"');
    expect(html).toContain('title="/Users/me/notes"');
    expect(html).toMatch(/data-connected-folder="app"[^]*<\/button><button[^>]+aria-label="Disconnect shop"[^]*data-connected-folder="notes"[^]*<\/button><button[^>]+aria-label="Disconnect notes"[^]*Add folder…/);
    // Closed until picked: no folder is read up front.
    expect(html).not.toContain('data-folder-tree');
  });

  it('lists the files open in the agent windows above the folders, marking the active one', () => {
    const html = renderSidebar({
      sessions: [agentSummary('chat', { title: 'Fix login' })], shows: 'files', settings: { workspaces: [app, notes] },
      openFiles: ['/code/shop/src/app.ts', '/Users/me/notes/todo.md'], activeFile: '/Users/me/notes/todo.md',
    });
    expect(html).toMatch(/data-open-files-heading[^]*data-open-file="\/code\/shop\/src\/app.ts"[^]*app.ts[^]*shop<\/span>[^]*data-open-file="\/Users\/me\/notes\/todo.md" aria-current="true"[^]*data-folders-heading[^]*data-connected-folder="app"/);
    expect(html).not.toMatch(/data-open-file="\/code\/shop\/src\/app.ts" aria-current/);
    // A file browser, not a list of agents.
    expect(html).not.toContain('Beside an agent');
    expect(html).not.toContain('Fix login');
  });

  it('has no Open heading when no file is open', () => {
    const html = renderSidebar({ sessions: [], shows: 'files', settings: { workspaces: [app] } });
    expect(html).not.toContain('data-open-files-heading');
    expect(html).not.toContain('data-folders-heading');
  });

  it('offers Add folder in the empty state without disconnect controls', () => {
    const html = renderSidebar({ sessions: [], shows: 'files', settings: { workspaces: [] } });
    expect(html).toMatch(/No folders connected[^]*Add folder…/);
    expect(html).not.toContain('aria-label="Disconnect ');
  });

  it('names a file by its last segment and tags it with the deepest folder holding it', () => {
    expect(baseName('C:\\code\\shop\\README.md')).toBe('README.md');
    expect(baseName('/code/shop/src/')).toBe('src');
    expect(folderOfFile('/code/shop/web/index.html', [app, web])?.id).toBe('web');
    expect(folderOfFile('/code/shop/package.json', [app, web])?.id).toBe('app');
    expect(folderOfFile('C:\\Code\\Shop\\a.ts', [{ ...app, path: 'c:/code/shop' }])?.id).toBe('app');
    // A sibling whose name only starts the same is not inside.
    expect(folderOfFile('/code/shopfront/a.ts', [app])).toBeUndefined();
  });
});

describe('a file window on the wall', () => {
  it('opens into the active zone, once, and survives a reload', () => {
    const wall = openWallPane(DEFAULT_WALL_STATE, 'file', '/code/shop/src/app.ts');
    // Asking again only shows the one already there.
    expect(openWallPane(wall, 'file', '/code/shop/src/app.ts')).toBe(wall);
    const files = openWallPane(wall, 'files', '/code/shop');
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
    // Browser and Files windows saved from before still load.
    const browser = openWallPane(DEFAULT_WALL_STATE, 'browser', 'http://localhost:5173/');
    for (const [state, want] of [[wall, 'file:/code/shop/src/app.ts'], [files, 'files:/code/shop'], [browser, 'browser:http://localhost:5173/']] as const) {
      saveWallState(storage, state);
      const root = loadWallState(storage).root as { kind?: string; refId?: string } | null;
      expect(`${root?.kind}:${root?.refId}`).toBe(want);
    }
  });
});
