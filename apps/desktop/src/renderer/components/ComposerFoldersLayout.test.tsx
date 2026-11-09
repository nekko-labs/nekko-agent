import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { chatSession, composerBox, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { useStore } from '../store.js';

const mode = vi.hoisted(() => ({ expert: false }));
vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('../simpleMode.js', async (original) => {
  const { simpleShown } = await import('@nekko-agent/shared');
  return { ...(await original<object>()), useExpertMode: () => [mode.expert, () => {}], useShown: (id: string) => simpleShown(id, mode.expert, {}) };
});

beforeEach(() => {
  withProvider();
  useStore.setState({ settings: { workspaces: [{ id: 'code', name: 'code', path: 'C:/fixture/code' }, { id: 'docs', name: 'docs', path: 'C:/fixture/docs' }] } as never, sessions: [] });
});

describe('folders have one stable composer location (#2339)', () => {
  for (const expert of [false, true]) for (const cleanStart of [false, true]) {
    it.each([{}, { commandCenter: true }, { surface: 'composer' as const }])(`keeps folders after plus, expert=${expert}, new=${cleanStart}: %j`, (props) => {
      mode.expert = expert;
      const session = chatSession({ messages: cleanStart ? [] : chatSession().messages, workspaceId: 'code', supportingWorkspaceIds: ['docs'] });
      const html = renderChatPane(session, { ...props, cleanStart });
      const box = composerBox(html);
      expect(html.match(/aria-label="Environment:/g)).toHaveLength(1);
      expect(box).toMatch(/class="composer-bar[^"]*"><div class="relative/);
      const folder = box.indexOf('aria-label="Environment: code, docs"');
      const plus = box.indexOf('aria-label="Add a photo, video, file, folder, or skill"');
      expect(folder).toBeGreaterThan(-1);
      expect(plus).toBeGreaterThan(-1);
      expect(folder).toBeGreaterThan(plus);
      expect(html).not.toContain('aria-label="Primary folder:');
      expect(box).not.toContain('mode-folders');
    });
  }
  it('keeps the picker with no selected or saved folder', () => {
    useStore.setState({ settings: { workspaces: [] } as never });
    const box = composerBox(renderChatPane(chatSession({ messages: [] }), { cleanStart: true, commandCenter: true }));
    expect(box).toContain('aria-label="Environment: none"');
    expect(box).toContain('No folder');
  });
});
