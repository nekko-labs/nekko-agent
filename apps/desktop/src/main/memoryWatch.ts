import { BrowserWindow, screen, type Tray } from 'electron';
import { IpcChannels, type AppSettings } from '@nekko-agent/shared';
import type { EngineProcess } from './engine-process.js';
import { companionBounds } from './trayCompanion.js';

/** What `memory:state` answers (nekko-machine's `memory.rs`). */
export type MemoryState = {
  level: 'ok' | 'low' | 'critical';
  totalBytes: number;
  availableBytes: number;
  commitLimitBytes?: number | null;
  commitAvailableBytes?: number | null;
  topApp?: { name: string; bytes: number; processes: number } | null;
  nekkoBytes?: number | null;
};

/** What `engine:memory` answers: the loaded local models, how many are replying, and what their processes hold. */
export type LocalModels = { models: number; busy: number; bytes: number };

export type MemoryChoice = 'close' | 'release' | 'ignore';
export type MemoryStep = { kind: 'none' } | { kind: 'ask' } | { kind: 'release' } | { kind: 'close'; app: string };
/** The last time the watch spoke up, and how bad it was then. */
export type MemoryMemo = { at: number; level: MemoryState['level'] } | null;

/** How often memory is read. */
export const MEMORY_POLL_MS = 15_000;
/** After asking or acting, stay quiet this long, unless it gets worse. */
export const MEMORY_QUIET_MS = 30 * 60_000;
/** An unanswered question goes away after this long (it counts as Ignore). */
export const MEMORY_PROMPT_MS = 2 * 60_000;
const RESULT_MS = 6_000;

const rank = { ok: 0, low: 1, critical: 2 } as const;

/**
 * What to do about memory now. An app the person always closes goes first;
 * then the remembered choice; otherwise ask. Nothing while memory is fine,
 * and nothing twice within the quiet time unless low turned critical.
 */
export function decideMemory(state: MemoryState, settings: Pick<AppSettings, 'lowMemoryAction' | 'lowMemoryCloseApps'>, memo: MemoryMemo, now: number): MemoryStep {
  if (state.level === 'ok') return { kind: 'none' };
  if (memo && now - memo.at < MEMORY_QUIET_MS && rank[state.level] <= rank[memo.level]) return { kind: 'none' };
  const app = state.topApp?.name;
  if (app && (settings.lowMemoryCloseApps ?? []).some(a => a.toLowerCase() === app.toLowerCase())) return { kind: 'close', app };
  const action = settings.lowMemoryAction ?? 'ask';
  if (action === 'ignore') return { kind: 'none' };
  if (action === 'release') return { kind: 'release' };
  return { kind: 'ask' };
}

/** The settings change that remembers a choice. */
export function rememberChoice(choice: MemoryChoice, app: string | undefined, settings: Pick<AppSettings, 'lowMemoryCloseApps'>): Partial<AppSettings> {
  if (choice === 'close') {
    const apps = settings.lowMemoryCloseApps ?? [];
    return app && !apps.some(a => a.toLowerCase() === app.toLowerCase()) ? { lowMemoryCloseApps: [...apps, app] } : {};
  }
  return { lowMemoryAction: choice };
}

export function gb(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GB`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** How much is left, from the tighter of physical memory and the commit limit. */
export function leftLine(state: MemoryState): string {
  const physical = state.availableBytes / state.totalBytes;
  const commit = state.commitLimitBytes && state.commitAvailableBytes != null ? state.commitAvailableBytes / state.commitLimitBytes : 1;
  return commit < physical
    ? `${gb(state.commitAvailableBytes ?? 0)} of ${gb(state.commitLimitBytes ?? 0)} left to allocate`
    : `${gb(state.availableBytes)} of ${gb(state.totalBytes)} free`;
}

const STYLE = `*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{position:relative;margin:0;padding:14px 16px;background:#101714;color:#f2f1e9;font:13px system-ui;border:2px solid #e2b36b;border-radius:14px}header{display:flex;gap:8px;align-items:center;margin:0 22px 6px 0}header svg{flex:none;width:32px;height:37px;margin:-9px 0 -2px}h1{font-size:15px;margin:0}p{margin:0 0 10px;line-height:1.45;color:#cad6cb}form{display:flex;flex-direction:column;gap:6px}button{font:inherit;text-align:left;padding:6px 10px;border:1px solid #a7c8ac;border-radius:7px;background:transparent;color:#f2f1e9;cursor:pointer}button:hover{background:#ffffff14}button.primary{background:#a7c8ac;color:#101714;border-color:#a7c8ac}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid white;outline-offset:2px}small{color:#9fb0a2}button small{display:block;margin-top:1px;font-size:12px}.primary small{color:#2f4a36}input{accent-color:#a7c8ac}label{display:flex;gap:6px;align-items:center;margin-top:4px;color:#cad6cb;font-size:12px}.x{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:#cad6cb;font-size:16px;text-decoration:none}.x:hover{background:#ffffff1a}`;
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://nekko.invalid"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

/**
 * Nekko looking shocked, with the "!" over its right ear: the iOS refresh
 * mascot's alarm pose (PixelCat `shocked`, PawArt `alarm`) on the same 32 x 32
 * grid, with room above for the mark.
 */
export const ALERT_MASCOT = '<svg viewBox="0 -7 34 39" shape-rendering="crispEdges" aria-hidden="true">'
  + '<path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#101714" stroke="#f2f1e9" stroke-width="2"/>'
  + '<path d="M10 14H14V15H10Z M10 17H14V18H10Z M10 15H11V17H10Z M13 15H14V17H13Z M19 14H23V15H19Z M19 17H23V18H19Z M19 15H20V17H19Z M22 15H23V17H22Z M15 22H17V24H15Z" fill="#f2f1e9"/>'
  + '<path d="M15 20H17V21H15Z" fill="#a7c8ac"/>'
  + '<path d="M29 -7H32V-2H29Z M29 -1H32V2H29Z" fill="#e2b36b"/></svg>';

/** What shutting the local models down costs: how many replies stop. */
export function modelsCost(models: LocalModels): string {
  const them = models.models === 1 ? 'it' : 'them';
  if (models.busy === 0) return `No agent is using ${them} right now.`;
  if (models.busy === 1) return models.models === 1 ? 'An agent replying on it stops.' : 'An agent replying on one of them stops.';
  return `${models.busy} agents replying on them stop.`;
}

/**
 * The question: close the app, shut down Nekko's local models, or ignore;
 * and whether to remember. Each option says what it frees, measured from the
 * processes it would end. With no model loaded there is nothing of Nekko's to
 * shut down, so that option is left out. No script: a form the main process
 * reads from its navigation.
 */
export function memoryPromptHtml(state: MemoryState, models: LocalModels | null = null): string {
  const app = state.topApp;
  const critical = state.level === 'critical';
  const release = models?.models !== 0;
  const releaseLine = models
    ? `Shut down ${models.models === 1 ? "Nekko's local model" : `Nekko's ${models.models} local models`}<small>Frees about ${gb(models.bytes)}. ${modelsCost(models)}</small>`
    : "Shut down Nekko's local models<small>Agents using them stop.</small>";
  return page('Nekko memory check', `<main><header>${ALERT_MASCOT}<h1>${critical ? 'Memory is almost gone' : 'Memory is running low'}</h1></header>
<p>${esc(leftLine(state))}. Apps may crash when it runs out.</p>
<form action="https://nekko.invalid/choose" method="get">
${app ? `<button class="primary" name="choice" value="close">Close ${esc(app.name)}<small>Frees about ${gb(app.bytes)}. It can still ask you to save first.</small></button><input type="hidden" name="app" value="${esc(app.name)}">` : ''}
${release ? `<button${app ? '' : ' class="primary"'} name="choice" value="release">${releaseLine}</button>` : ''}
<button name="choice" value="ignore">Ignore</button>
<label><input type="checkbox" name="remember" value="1"> Remember this choice</label>
</form></main><a class="x" href="https://nekko.invalid/dismiss" aria-label="Dismiss" title="Dismiss">&#215;</a>`);
}

/** Card padding and border below the content, added to its measured height. */
const CARD_BOTTOM = 16;

export function memoryResultHtml(message: string): string {
  return page('Nekko memory check', `<main><header>${ALERT_MASCOT}<h1>Memory was low</h1></header><p>${esc(message)}</p></main><a class="x" href="https://nekko.invalid/dismiss" aria-label="Dismiss" title="Dismiss">&#215;</a>`);
}

/** Reads a choice out of the prompt's form navigation. */
export function parseChoice(url: string): { choice: MemoryChoice; app?: string; remember: boolean } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== 'https://nekko.invalid' || u.pathname !== '/choose') return null;
  const choice = u.searchParams.get('choice');
  if (choice !== 'close' && choice !== 'release' && choice !== 'ignore') return null;
  return { choice, app: u.searchParams.get('app') ?? undefined, remember: u.searchParams.get('remember') === '1' };
}

/**
 * Watches memory while the service runs, and when it runs low, asks above the
 * tray (or the corner, where the tray has no position) what to do, or does
 * what the person asked to be remembered. While a full-screen game is in
 * front (`quiet`, foregroundGuard.ts) nothing is shown over it: the question
 * waits, and a remembered choice still runs without its note.
 */
export function createMemoryWatch(options: { tray: Tray; engine: EngineProcess; quiet?: () => Promise<boolean>; onError: (message: string) => void }) {
  const { engine } = options;
  let popup: BrowserWindow | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let memo: MemoryMemo = null;
  let busy = false;
  let disposed = false;
  const dismiss = () => { clearTimeout(timer); popup?.destroy(); popup = null; };

  const show = async (html: string, ms: number, onNavigate?: (url: string) => void) => {
    dismiss();
    const anchor = options.tray.getBounds();
    const work = screen.getDisplayMatching(anchor).workArea;
    const win = new BrowserWindow({ ...companionBounds(anchor, work, 360, 320), title: 'Nekko memory check', show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#101714', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    popup = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'https://nekko.invalid/dismiss') { dismiss(); return; }
      onNavigate?.(url);
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    if (disposed || popup !== win || win.isDestroyed()) return;
    // Fit the card to what it says (an app name or a note can wrap), then place it.
    const content = await win.webContents.executeJavaScript('Math.ceil(document.querySelector("main").getBoundingClientRect().bottom)').catch(() => 0) as number;
    if (disposed || popup !== win || win.isDestroyed()) return;
    if (content > 0) win.setBounds(companionBounds(anchor, work, 360, content + CARD_BOTTOM));
    // Never takes focus from what the person is doing.
    win.showInactive();
    timer = setTimeout(dismiss, ms);
  };
  let hushed = false;
  const tell = (message: string) => hushed ? Promise.resolve() : show(memoryResultHtml(message), RESULT_MS);

  const localModels = () => engine.call<LocalModels>(IpcChannels.engineMemory).catch(() => null);
  const release = async (): Promise<string> => {
    // What the model processes hold just before: what shutting them down frees.
    const before = await localModels();
    const r = await engine.call<{ unloaded: string[]; freedBytes: number; stopped: number }>(IpcChannels.engineUnloadAll);
    if (!r.unloaded.length) return 'No local model was loaded, so there was nothing to shut down.';
    const shut = `Shut down ${r.unloaded.length === 1 ? 'a local model' : `${r.unloaded.length} local models`}, freeing about ${gb(before?.bytes || r.freedBytes)}.`;
    return r.stopped ? `${shut} ${r.stopped === 1 ? 'An agent reply was' : `${r.stopped} agent replies were`} stopped.` : shut;
  };
  const close = async (app: string): Promise<string> => {
    const r = await engine.call<{ ok: boolean; message?: string }>(IpcChannels.memoryCloseApp, app);
    return r.ok ? `Asked ${app} to close.` : (r.message ?? `Could not close ${app}.`);
  };
  const act = async (choice: MemoryChoice, app: string | undefined) => {
    if (choice === 'release') await tell(await release());
    else if (choice === 'close' && app) await tell(await close(app));
  };

  const check = async () => {
    if (busy || disposed || !engine.running || popup) return;
    busy = true;
    try {
      const state = await engine.call<MemoryState>(IpcChannels.memoryState);
      if (state.level === 'ok') { memo = null; return; }
      const settings = await engine.call<AppSettings>(IpcChannels.settingsGet);
      const step = decideMemory(state, settings, memo, Date.now());
      if (step.kind === 'none') return;
      hushed = (await options.quiet?.()) === true;
      // The question waits for the game to leave; it is asked on a later look.
      if (step.kind === 'ask' && hushed) return;
      const models = await localModels();
      // A remembered shut-down with nothing loaded has nothing to do or say.
      if (step.kind === 'release' && models?.models === 0) return;
      memo = { at: Date.now(), level: state.level };
      if (step.kind === 'release') await act('release', undefined);
      else if (step.kind === 'close') await act('close', step.app);
      else {
        await show(memoryPromptHtml(state, models), MEMORY_PROMPT_MS, url => {
          const picked = parseChoice(url);
          if (!picked) return;
          dismiss();
          void (async () => {
            if (picked.remember) await engine.call(IpcChannels.settingsUpdate, rememberChoice(picked.choice, picked.app, settings));
            await act(picked.choice, picked.app);
          })().catch(e => options.onError(e instanceof Error ? e.message : String(e)));
        });
      }
    } catch { /* an older daemon or a stopped one: nothing to watch */ }
    finally { busy = false; }
  };
  const poll = setInterval(() => { void check(); }, MEMORY_POLL_MS);
  return { check, dismiss, dispose() { disposed = true; clearInterval(poll); dismiss(); } };
}
