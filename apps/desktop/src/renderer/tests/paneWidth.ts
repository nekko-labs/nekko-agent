/**
 * A pane width for server renders. ChatPane measures its width with a
 * ResizeObserver, which never runs on the server, so it would always render
 * as a 0px pane (no plan rail, no plan toggle). A test that needs a wide pane
 * mocks the hook with this and sets `paneWidth.value`:
 *
 *   vi.mock('../components/agent-console/useElementWidth.js', (o) => elementWidthMock(o));
 */
export const paneWidth = { value: 0 };

export async function elementWidthMock<T extends object>(original: () => Promise<T>): Promise<T> {
  return { ...(await original()), useElementWidth: () => paneWidth.value };
}
