/**
 * In-process CDP for the agent browser.
 *
 * Playwright normally reaches Chromium through a remote-debugging port, and an
 * open port lets any local process (including a shell command the agent runs)
 * drive every window of the app, the Nekko UI and its approval prompts among
 * them. This transport avoids the port entirely: it speaks CDP to Playwright as
 * if it were a browser, but its only targets are the agent browser windows one
 * chat owns, each reached through Electron's `webContents.debugger`. The UI
 * windows are never attached, never listed and cannot be reached by id.
 *
 * Every command passes a policy check first: only page-level domains Playwright
 * needs, no target discovery or attachment beyond the chat's own pages, no
 * local file uploads, no download or certificate overrides, and HTTP(S) or
 * about:blank navigation only.
 */

export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<any>;
  on(event: 'message', listener: (event: unknown, method: string, params: any, sessionId?: string) => void): unknown;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface AgentTarget {
  webContents: { debugger: DebuggerLike; isDestroyed(): boolean };
}

export interface AgentCdpHost {
  product: string;
  userAgent: string;
  /** Native discovery is still limited to explicitly adopted windows. */
  nativeDiscovery?: boolean;
  /** Open one more window for this chat, already showing about:blank. */
  createTarget(): Promise<AgentTarget>;
  closeTarget(target: AgentTarget): void;
}

type Message = { id?: number; method?: string; params?: any; sessionId?: string; result?: unknown; error?: { message: string } };

interface Attached {
  target: AgentTarget;
  targetId: string;
  sessionId: string;
  children: Set<string>;
  onMessage: (event: unknown, method: string, params: any, sessionId?: string) => void;
  onDetach: () => void;
}

/** Domains a page session may use. Anything else is refused. */
const PAGE_DOMAINS = new Set(['Page', 'Runtime', 'DOM', 'DOMSnapshot', 'Accessibility', 'CSS', 'Network', 'Fetch', 'Input', 'Emulation', 'Log', 'Overlay', 'IO', 'Inspector', 'Debugger', 'Profiler', 'Performance', 'Animation', 'Target']);
/** Target methods a page session may use; the rest could reach other targets. */
const PAGE_TARGET_METHODS = new Set(['Target.setAutoAttach', 'Target.detachFromTarget', 'Target.getTargetInfo']);
const DENIED_PAGE_METHODS = new Set([
  'DOM.setFileInputFiles', // reads arbitrary local files into the page
  'Page.setDownloadBehavior',
  'Target.exposeDevToolsProtocol',
]);

export const isAllowedNavigation = (url: unknown): boolean => typeof url === 'string' && (/^https?:\/\//i.test(url) || url === 'about:blank');

/** Why a page-session command is refused, or undefined when allowed. */
export function pageCommandDenial(method: string, params: any): string | undefined {
  const domain = method.split('.')[0];
  if (!PAGE_DOMAINS.has(domain) || DENIED_PAGE_METHODS.has(method)) return `${method} is not available in the Nekko agent browser.`;
  if (domain === 'Target' && !PAGE_TARGET_METHODS.has(method)) return `${method} is not available in the Nekko agent browser.`;
  if (method === 'Target.getTargetInfo' && params?.targetId !== undefined) return 'Target.getTargetInfo is limited to the current page.';
  if (method === 'Page.navigate' && !isAllowedNavigation(params?.url)) return 'Only HTTP(S) pages can be opened.';
  return undefined;
}

export class AgentCdpTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private closed = false;
  private nextSession = 1;
  private readonly attached = new Map<string, Attached>(); // by our page session id
  private readonly children = new Map<string, Attached>(); // child session id -> owning page
  private readonly pending = new Set<AgentTarget>();
  private autoAttach = false;

  constructor(private readonly host: AgentCdpHost) {}

  send(message: object): void {
    void this.dispatch(message as Message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.attached.values()]) this.release(entry, false);
    this.onclose?.('Agent browser disconnected.');
  }

  /** The window behind a Playwright page session, if this transport owns it. */
  targetFor(targetId: string): AgentTarget | undefined {
    for (const entry of this.attached.values()) if (entry.targetId === targetId) return entry.target;
    return undefined;
  }

  /** Report a window that was closed outside Playwright (reaper, user, crash). */
  forget(target: AgentTarget): void {
    for (const entry of this.attached.values()) if (entry.target === target) this.release(entry, true);
  }

  private emit(message: Message): void {
    if (!this.closed) this.onmessage?.(message);
  }

  private reply(id: number | undefined, sessionId: string | undefined, result: unknown): void {
    this.emit({ id, ...(sessionId ? { sessionId } : {}), result: result ?? {} });
  }

  private fail(id: number | undefined, sessionId: string | undefined, message: string): void {
    this.emit({ id, ...(sessionId ? { sessionId } : {}), error: { message } });
  }

  private async dispatch(message: Message): Promise<void> {
    const { id, method = '', params, sessionId } = message;
    if (this.closed) return;
    try {
      if (!sessionId) { this.reply(id, undefined, await this.browserCommand(method, params)); return; }
      const page = this.attached.get(sessionId);
      const owner = page ?? this.children.get(sessionId);
      if (!owner) { this.fail(id, sessionId, `No session ${sessionId}.`); return; }
      const denial = pageCommandDenial(method, params);
      if (denial) { this.fail(id, sessionId, denial); return; }
      const result = await owner.target.webContents.debugger.sendCommand(method, params ?? {}, page ? undefined : sessionId);
      this.reply(id, sessionId, result);
    } catch (error) {
      this.fail(id, sessionId, (error as Error)?.message ?? String(error));
    }
  }

  private async browserCommand(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'Target.setDiscoverTargets':
        if (!this.host.nativeDiscovery) throw new Error('Discovery is not available.');
        return {};
      case 'Target.getTargets':
        if (!this.host.nativeDiscovery) throw new Error('Discovery is not available.');
        return { targetInfos: [...this.attached.values()].map((entry) => ({ targetId: entry.targetId, type: 'page', title: '', url: 'about:blank', attached: true, browserContextId: 'nekko-agent-context' })) };
      case 'Target.attachToTarget': {
        if (!this.host.nativeDiscovery || params?.flatten !== true) throw new Error('Attachment is not available.');
        const entry = [...this.attached.values()].find((entry) => entry.targetId === params?.targetId);
        if (!entry) throw new Error('No such owned page.');
        return { sessionId: entry.sessionId };
      }
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: this.host.product, revision: '', userAgent: this.host.userAgent, jsVersion: process.versions.v8 };
      case 'Target.setAutoAttach':
        this.autoAttach = !!params?.autoAttach;
        for (const target of [...this.pending]) { this.pending.delete(target); await this.attach(target); }
        return {};
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: 'nekko-agent-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      case 'Browser.setDownloadBehavior':
        // Downloads stay denied by the window's session; accept the call so
        // Playwright's context setup succeeds without changing that.
        return {};
      case 'Target.createTarget': {
        if (params?.url !== undefined && !isAllowedNavigation(params.url)) throw new Error('Only HTTP(S) pages can be opened.');
        const target = await this.host.createTarget();
        const entry = await this.attach(target);
        return { targetId: entry.targetId };
      }
      case 'Target.closeTarget': {
        const entry = [...this.attached.values()].find((e) => e.targetId === params?.targetId);
        if (!entry) throw new Error('No such page.');
        this.release(entry, true);
        this.host.closeTarget(entry.target);
        return { success: true };
      }
      case 'Target.detachFromTarget': {
        const entry = this.attached.get(params?.sessionId);
        if (entry) this.release(entry, true);
        return {};
      }
      case 'Browser.close':
        return {};
      default:
        throw new Error(`${method} is not available in the Nekko agent browser.`);
    }
  }

  /** Expose a window to Playwright (immediately once Playwright is listening). */
  async add(target: AgentTarget): Promise<void> {
    if (this.autoAttach) await this.attach(target);
    else this.pending.add(target);
  }

  private async attach(target: AgentTarget): Promise<Attached> {
    const existing = [...this.attached.values()].find((e) => e.target === target);
    if (existing) return existing;
    const dbg = target.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const { targetInfo } = await dbg.sendCommand('Target.getTargetInfo');
    const sessionId = `nekko-page-${this.nextSession++}`;
    const entry: Attached = {
      target, targetId: targetInfo.targetId, sessionId, children: new Set(),
      onMessage: (_event, method, params, childSession) => {
        if (method === 'Target.attachedToTarget' && params?.sessionId) { entry.children.add(params.sessionId); this.children.set(params.sessionId, entry); }
        if (method === 'Target.detachedFromTarget' && params?.sessionId) { entry.children.delete(params.sessionId); this.children.delete(params.sessionId); }
        this.emit({ method, params, sessionId: childSession || sessionId });
      },
      onDetach: () => this.release(entry, true),
    };
    dbg.on('message', entry.onMessage);
    dbg.on('detach', entry.onDetach);
    this.attached.set(sessionId, entry);
    this.emit({ method: 'Target.attachedToTarget', params: { sessionId, waitingForDebugger: false, targetInfo: { ...targetInfo, type: 'page', attached: true, browserContextId: 'nekko-agent-context' } } });
    return entry;
  }

  private release(entry: Attached, notify: boolean): void {
    if (!this.attached.delete(entry.sessionId)) return;
    for (const child of entry.children) this.children.delete(child);
    const dbg = entry.target.webContents.debugger;
    dbg.removeListener('message', entry.onMessage);
    dbg.removeListener('detach', entry.onDetach);
    try { if (!entry.target.webContents.isDestroyed() && dbg.isAttached()) dbg.detach(); } catch { /* already gone */ }
    if (notify) this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: entry.sessionId, targetId: entry.targetId } });
  }
}
