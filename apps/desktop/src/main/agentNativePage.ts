import type { BrowserWindow } from 'electron';
import { AgentNativeClient } from './agentNativeClient.js';

/** Bounded page API used by the tool, intentionally not an arbitrary CLI adapter. */
export class AgentNativePage {
  private readonly listeners = new Map<string, ((...args: any[]) => void)[]>();
  private readonly requests = new Map<string, { method: string; url: string }>();
  constructor(private readonly client: AgentNativeClient, private readonly win: BrowserWindow) {
    win.webContents.debugger.on('message', (_event, method, params) => {
      const emit = (event: string, value: unknown) => { for (const listener of this.listeners.get(event) ?? []) listener(value); };
      if (method === 'Network.requestWillBeSent') this.requests.set(params.requestId, params.request);
      if (method === 'Network.responseReceived') {
        const request = this.requests.get(params.requestId);
        if (params.response.status >= 400) emit('response', { status: () => params.response.status, url: () => params.response.url, request: () => ({ method: () => request?.method ?? 'GET' }) });
      }
      if (method === 'Network.loadingFailed') {
        const request = this.requests.get(params.requestId);
        emit('requestfailed', { method: () => request?.method ?? 'GET', url: () => request?.url ?? '', failure: () => ({ errorText: params.errorText }) });
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') this.requests.delete(params.requestId);
      if (method === 'Runtime.exceptionThrown') emit('pageerror', { message: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'Page error' });
      if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value!);
    });
  }
  url(): string { return this.win.webContents.getURL(); }
  async title(): Promise<string> { return this.win.webContents.getTitle(); }
  async evaluate<R, A = undefined>(expression: string | ((arg: A) => R), arg?: A): Promise<Awaited<R>> {
    const script = typeof expression === 'string' ? expression : `(${expression.toString()})(${JSON.stringify(arg) ?? 'undefined'})`;
    const data = await this.client.command('evaluate', { script });
    return data.result;
  }
  async goto(url: string): Promise<void> { await this.client.command('navigate', { url, waitUntil: 'load' }); }
  async screenshot(): Promise<Buffer> {
    // Same owned debugger and screenshot policy, without upstream filesystem writes.
    const viewport = await this.evaluate(() => ({ x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight }));
    const result = await this.win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { ...viewport, scale: 1 } });
    return Buffer.from(result.data, 'base64');
  }
  on(event: string, listener: (...args: any[]) => void): this {
    const existing = this.listeners.get(event) ?? []; existing.push(listener); this.listeners.set(event, existing);
    const wc = this.win.webContents;
    if (event === 'console') wc.on('console-message', (event) => listener({ type: () => event.level, text: () => event.message }));
    return this;
  }
  private async focus(selector: string): Promise<void> {
    await this.poll(selector, undefined, 'attached', 10_000);
    await this.evaluate((s) => { const el = document.querySelector(s) as HTMLElement | null; if (!el) throw new Error('Selector not found.'); el.focus(); }, selector);
  }
  readonly keyboard = {
    type: async (text: string): Promise<void> => { await this.client.command('type', { selector: ':focus', text }); },
    press: async (key: string): Promise<void> => { await this.client.command('press', { key }); },
  };
  locator(selector: string) { return this.target(selector); }
  getByText(text: string) { return this.target(undefined, text); }
  private target(selector?: string, text?: string) {
    const self = this;
    const target = {
      first: () => target,
      click: async (_options?: unknown) => { await self.client.command('click', { selector }); },
      fill: async (value: string, _options?: unknown) => { await self.client.command('fill', { selector, value }); },
      pressSequentially: async (value: string, _options?: unknown) => { await self.focus(selector!); await self.keyboard.type(value); },
      press: async (key: string, _options?: unknown) => { await self.focus(selector!); await self.keyboard.press(key); },
      waitFor: async (options: { state: 'visible' | 'attached' | 'hidden' | 'detached'; timeout: number }) => self.poll(selector, text, options.state, options.timeout),
      scrollIntoViewIfNeeded: async (_options?: unknown) => { await self.poll(selector, undefined, 'attached', 10_000); await self.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), selector!); },
      innerText: async (_options?: unknown) => { await self.poll(selector, undefined, 'attached', 10_000); return self.evaluate((s) => (document.querySelector(s) as HTMLElement).innerText, selector!); },
    };
    return target;
  }
  private async poll(selector: string | undefined, text: string | undefined, state: 'visible' | 'attached' | 'hidden' | 'detached', timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    do {
      const status = await this.evaluate(({ selector, text }) => {
        const el = selector ? document.querySelector(selector) : [...document.querySelectorAll('body *')].find((el) => el.textContent?.includes(text!) && ![...el.children].some((child) => child.textContent?.includes(text!)));
        if (!el) return { attached: false, visible: false };
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        return { attached: true, visible: style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0 };
      }, { selector, text });
      if (state === 'attached' ? status.attached : state === 'detached' ? !status.attached : state === 'visible' ? status.visible : !status.visible) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${selector ?? text} to be ${state}.`);
  }
}
