import '../tests/browserGlobals.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { liveStore } from '../tests/liveStore.js';
import { renderSidebar } from '../tests/renderSidebar.js';
import { useStore } from '../store.js';
import type { TerminalInfo } from '@nekko-agent/shared';
vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
const t = (id: string): TerminalInfo => ({ id, title: id, cwd: '/project', shell: '/bin/zsh', running: true, createdAt: 1 });
beforeEach(() => useStore.setState({ terminals: [], workspaces: [] }));
it('lists each registry terminal once, regardless of workspace anchors or splits', () => {
  useStore.setState({ terminals: [t('anchored'), t('split'), t('unopened'), { ...t('exited'), running: false }, t('agent_log')], workspaces: [
    { id: 'wt', anchor: { kind: 'terminal', refId: 'anchored' }, activePaneId: 'pt', root: { id: 'pt', kind: 'terminal', refId: 'anchored' } },
    { id: 'wc', anchor: { kind: 'chat', refId: 's1' }, activePaneId: 'pc', root: { id: 'r', dir: 'row', sizes: [.5,.5], children: [{ id: 'pc', kind: 'chat', refId: 's1' }, { id: 'ps', kind: 'terminal', refId: 'split' }] } },
  ] });
  for (const orientation of ['vertical', 'horizontal'] as const) {
    const html = renderSidebar({ orientation });
    expect([...html.matchAll(/data-terminal-row="([^"]+)"/g)].map(m => m[1]).sort()).toEqual(['anchored', 'exited', 'split', 'unopened']);
  }
});
it('shows smart title and attention state without pretending the terminal is a chat', () => {
  useStore.setState({ terminals: [{ ...t('claude'), activity: { title: 'Fix login', state: 'attention', detail: 'Claude Code needs permission' } }] });
  const html = renderSidebar();
  expect(html).toContain('Fix login'); expect(html).toContain('Needs attention'); expect(html).toContain('Claude Code needs permission');
});
