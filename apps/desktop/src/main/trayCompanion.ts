import { BrowserWindow, screen, type Rectangle, type Tray } from 'electron';
import type { AppSettings } from '@nekko-agent/shared';

export function companionBounds(tray: Rectangle, work: Rectangle, width = 340, height = 230): Rectangle {
  const anchored = tray.width > 0 && tray.height > 0;
  const x = anchored ? tray.x + tray.width / 2 - width / 2 : work.x + work.width - width - 12;
  const y = anchored && tray.y < work.y + work.height / 2 ? tray.y + tray.height + 8 : (anchored ? tray.y : work.y + work.height) - height - 8;
  return { x: Math.round(Math.max(work.x, Math.min(x, work.x + work.width - width))), y: Math.round(Math.max(work.y, Math.min(y, work.y + work.height - height))), width, height };
}

/** How long the first-close guidance stays up before it dismisses itself. */
export const GUIDANCE_MS = 15_000;
/** The farewell shown on later closes is a quick wave. */
export const FAREWELL_MS = 2_000;

export function companionHtml(first: boolean, farewell: boolean, serviceRunning: boolean, phrase = 'See ya!'): string {
  // The window is sized to fit; overflow is clipped so no scrollbar can appear.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Nekko tray companion</title><style>
  *{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{position:relative;margin:0;padding:14px 16px;background:#101714;color:#f2f1e9;font:14px system-ui;border:2px solid #a7c8ac;border-radius:14px}main{display:flex;gap:14px;align-items:center}.x{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;color:#cad6cb;font-size:16px;line-height:1}.x:hover{background:#ffffff1a;color:#f2f1e9}svg{flex:none;width:64px;height:64px;image-rendering:pixelated}.happy{animation:blink 1s steps(1) infinite}.closed{opacity:0;animation:blink 1s steps(1) infinite reverse}@keyframes blink{0%,85%{opacity:1}86%,100%{opacity:0}}@media(prefers-reduced-motion:reduce){.happy,.closed{animation:none}.closed{opacity:0}}h1{font-size:16px;margin:0 22px 4px 0}p{margin:0;line-height:1.45;color:#cad6cb}nav{display:flex;gap:6px;margin-top:10px}a{color:#f2f1e9;text-decoration:none}nav a{padding:3px 9px;border:1px solid #a7c8ac;border-radius:6px;line-height:16px;white-space:nowrap;font-size:12px}a:focus-visible{outline:2px solid white;outline-offset:2px}.primary{background:#a7c8ac;color:#101714}
  </style></head><body><main>${farewell ? `<svg viewBox="0 0 32 32" shape-rendering="crispEdges" aria-label="Nekko smiling and blinking"><path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#101714" stroke="#f2f1e9" stroke-width="2"/><g fill="#f2f1e9"><path class="happy" d="M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z"/><path class="closed" d="M10 17H14V18H10Z M19 17H23V18H19Z"/></g><path d="M14 20H18V21H14Z" fill="#a7c8ac"/></svg>` : ''}<div><h1>${first ? 'Nekko is still here!' : phrase}</h1><p>${first ? (serviceRunning ? 'Your agents are still running here in the system tray. Closing the window does not stop them.' : 'Nekko stays in the system tray. The service is currently stopped.') : (serviceRunning ? 'Your agents can keep working.' : 'See you next time!')}</p></div></main>${first ? '<nav aria-label="Close behavior"><a class="primary" href="https://nekko.invalid/dismiss">Got it</a><a href="https://nekko.invalid/shutdown">Shut down on close instead</a></nav><a class="x" href="https://nekko.invalid/dismiss" aria-label="Dismiss" title="Dismiss">&#215;</a>' : ''}</body></html>`;
}

/** A sandboxed local-only companion, never an application/deep-link target. */
export function createTrayCompanion(options: { tray: Tray; settings: () => Promise<AppSettings>; update: (patch: Partial<AppSettings>) => Promise<unknown>; quit: () => void; serviceRunning: () => boolean; onError: (message: string) => void }) {
  let popup: BrowserWindow | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let disposed = false;
  const dismiss = () => { clearTimeout(timer); popup?.destroy(); popup = null; };
  return {
    async closeWindow(hide: () => void) {
      if (busy || disposed) return;
      busy = true;
      try {
        const settings = await options.settings();
        if (disposed) return;
        if (settings.desktopCloseBehavior === 'shutdown') { options.quit(); return; }
        const first = settings.trayCloseHintSeen !== true && options.serviceRunning();
        // Persist before hiding, so a failed write leaves an actionable UI.
        if (first) await options.update({ trayCloseHintSeen: true });
        if (disposed) return;
        hide();
        dismiss();
        const running = options.serviceRunning();
        options.tray.setToolTip(running ? 'Nekko Agent: your agents are still running here' : 'Nekko Agent: service stopped');
        if (first && process.platform === 'win32') options.tray.displayBalloon({ title: 'Nekko is still here!', content: running ? 'Your agents are still running in the system tray. Click the Nekko icon to return.' : 'Nekko is in the system tray. The service is stopped.', noSound: true });
        if (!first && settings.trayFarewellEnabled === false) return;
        const anchor = options.tray.getBounds();
        const work = screen.getDisplayMatching(anchor).workArea;
        const win = new BrowserWindow({ ...companionBounds(anchor, work, 340, first ? 150 : 116), title: 'Nekko tray companion', show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#101714', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        popup = win;
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event, url) => {
          event.preventDefault();
          if (url === 'https://nekko.invalid/dismiss') dismiss();
          if (url === 'https://nekko.invalid/shutdown') {
            void options.update({ desktopCloseBehavior: 'shutdown' }).then(() => { dismiss(); options.quit(); }).catch(e => options.onError(String(e)));
          }
        });
        const phrases = ['See ya!', 'Nyaa!', 'Bye!', 'Catch you later!'];
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(companionHtml(first, settings.trayFarewellEnabled !== false, running, phrases[Math.floor(Math.random() * phrases.length)])));
        if (disposed || popup !== win || win.isDestroyed()) return;
        win.showInactive();
        // The guidance goes away by itself after 15 s; the farewell after 2 s.
        timer = setTimeout(dismiss, first ? GUIDANCE_MS : FAREWELL_MS);
      } catch (e) { options.onError(`Could not close Nekko Agent safely: ${String(e)}`); }
      finally { busy = false; }
    },
    dismiss,
    dispose() { disposed = true; dismiss(); },
  };
}
