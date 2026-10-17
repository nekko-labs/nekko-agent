/** Narrow tool-facing page contract, independent of either browser library. */
export interface AgentLocator {
  first(): AgentLocator;
  click(options?: unknown): Promise<unknown>;
  fill(value: string, options?: unknown): Promise<unknown>;
  pressSequentially(value: string, options?: unknown): Promise<unknown>;
  press(key: string, options?: unknown): Promise<unknown>;
  waitFor(options: { state: 'visible' | 'attached' | 'hidden' | 'detached'; timeout: number }): Promise<unknown>;
  scrollIntoViewIfNeeded(options?: unknown): Promise<unknown>;
  innerText(options?: unknown): Promise<string>;
}
export interface AgentPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: unknown): Promise<unknown>;
  evaluate<R, A = undefined>(expression: string | ((arg: A) => R), arg?: A): Promise<Awaited<R>>;
  screenshot(options?: unknown): Promise<Buffer>;
  on(event: any, listener: (...args: any[]) => void): unknown;
  locator(selector: string): AgentLocator;
  getByText(text: string): AgentLocator;
  keyboard: { type(text: string): Promise<unknown>; press(key: string): Promise<unknown> };
}
