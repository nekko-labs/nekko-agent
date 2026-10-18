import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { liveStore } from '../tests/liveStore.js';
import { elementWidthMock, paneWidth } from '../tests/paneWidth.js';
import { chatSession, renderChatPane, withProvider } from '../tests/renderChatPane.js';
import { loadWall, summary, windowBody } from '../tests/renderWall.js';
import { useStore } from '../store.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));
vi.mock('./agent-console/useElementWidth.js', (original) => elementWidthMock(original));

const empty = (patch: Parameters<typeof chatSession>[0] = {}) => chatSession({ messages: [], ...patch });
const isClean = (html: string) => html.includes('data-clean-start="true"');

beforeEach(() => {
  withProvider();
  // Wide enough that the Agent Monitor would show, so hiding it is the clean start's doing.
  paneWidth.value = 1200;
  useStore.setState({ planRailOpen: true, planRailOpenBySession: {} });
});

describe('focus mode clean start', () => {
  it('is asked for by the focused wall chat only', async () => {
    const wall = await loadWall();
    const two = { root: { id: 'r', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'a', kind: 'chat', refId: 'a' }, { id: 'b', kind: 'chat', refId: 'b' }] } as never };
    const focus = wall.render({ ...two, layout: { mode: 'focus', cols: 2, rows: 1 }, hero: 'a' }, { sessions: [summary('a'), summary('b')] });
    expect(windowBody(focus, 'a')).toContain('data-clean-start="true"');
    expect(windowBody(focus, 'b')).toContain('data-clean-start="false"');
    const grid = wall.render({ ...two, layout: { mode: 'grid', cols: 2, rows: 1 }, hero: 'a' }, { sessions: [summary('a'), summary('b')] });
    expect(grid).not.toContain('data-clean-start="true"');
  });

  it('lasts only while the chat is empty, on the full surface, with a model and nothing needing the user', () => {
    expect(isClean(renderChatPane(empty(), { commandCenter: true, cleanStart: true }))).toBe(true);
    expect(isClean(renderChatPane(empty(), { commandCenter: true, cleanStart: false }))).toBe(false);
    expect(isClean(renderChatPane(chatSession(), { commandCenter: true, cleanStart: true }))).toBe(false);
    expect(isClean(renderChatPane(empty(), { commandCenter: true, cleanStart: true, surface: 'transcript' }))).toBe(false);
    expect(isClean(renderChatPane(empty(), { commandCenter: true, cleanStart: true, readOnly: true }))).toBe(false);
    expect(isClean(renderChatPane(empty({ chatType: 'image' }), { commandCenter: true, cleanStart: true }))).toBe(false);
    // No provider yet: the setup welcome shows instead.
    useStore.setState({ providers: [] });
    expect(isClean(renderChatPane(empty(), { commandCenter: true, cleanStart: true }))).toBe(false);
  });

  it('hides the header, transcript, footer and monitor while on', () => {
    const clean = renderChatPane(empty(), { cleanStart: true });
    const normal = renderChatPane(empty(), { cleanStart: false });
    for (const [what, marker] of [['header', '<header'], ['transcript', 'data-transcript-scroll'], ['footer', 'aria-label="Chat actions and information"'], ['monitor', 'aria-label="Plan and sub-agents"']]) {
      expect(normal, what).toContain(marker);
      expect(clean, what).not.toContain(marker);
    }
    // The composer itself stays, centred.
    expect(clean).toContain('class="composer relative"');
    expect(clean).toMatch(/<section class="[^"]*\bclean-start justify-center\b/);
  });
});
