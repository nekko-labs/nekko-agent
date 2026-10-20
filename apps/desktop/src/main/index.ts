// First, so every module below sees the real packaging state in dev.
import './devRuntime.js';
import { NOTIFICATION_VISIBILITY_CHANNEL, visibleNotificationSession, visibleNotificationView, notificationWindowContext, trustedNotificationReporter } from '../notificationVisibility.js';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { fileURLToPath } from 'url';
import { join, resolve, sep } from 'path';
import { existsSync, readFileSync } from 'fs';
import { defaultUserDataDir, legacyUserDataDirs, migrateUserData, prepareUserDataRoot } from '@nekko-agent/profile/user-data';
import { brandEnv, IpcChannels, IpcEvents, type ApiServerStatus, type AppSettings } from '@nekko-agent/shared';
import { pickFolderDialog, registerIpc, shellBridge } from './ipc.js';
import { initialWindowBounds, loadWindowBounds, MIN_WINDOW, saveWindowBounds, setWindowStateDir } from './windowState.js';
import { registerDevLaunch, reportDevReady } from './devLaunchProcess.js';
import { preservePackagedProfile } from './appIdentity.js';
import { EngineProcess } from './engine-process.js';
import { startAppLog } from './appLog.js';
import { createDesktopTray } from './tray.js';
import { createTrayCompanion } from './trayCompanion.js';
import { startAgentBrowser } from './agentBrowser.js';
import { registerArtifactPreview } from './artifactPreview.js';
import { offerLegacyCleanup } from './legacyPrompt.js';
import { createCloseIntent, readWParam, WM_CLOSE, WM_SYSCOMMAND } from './closeIntent.js';
import { startMainNotifications, createNativeNotificationPoster } from './notifications.js';
import { createDisplayWindows, type DisplayWindows } from './displayWindows.js';
import {
  DISPLAY_ARG, DISPLAYS_CHANGED_EVENT, DISPLAYS_CLAIM_CHANNEL, DISPLAYS_LIST_CHANNEL, DISPLAYS_PLACED_EVENT,
  DISPLAYS_PLACEMENT_CHANNEL, DISPLAYS_REPORT_CHANNEL, DISPLAYS_TOGGLE_CHANNEL, MAIN_KEY,
} from '../displayWindows.js';
const applicationWindows = new Set<number>();

let desktopTray: ReturnType<typeof createDesktopTray> | null = null;
let quitting = false;
let mainWindow: BrowserWindow | null = null;
let trayCompanion: ReturnType<typeof createTrayCompanion> | undefined;
let stopNotifications: (() => void) | undefined;
let nativeNotifications: ReturnType<typeof createNativeNotificationPoster> | undefined;
const notificationSessions = new Map<number, string | null>();
/** Each window's view on screen, so a workflow run notice stays quiet on the Workflows view. */
const notificationViews = new Map<number, string | null>();

function showWindow(): void {
  trayCompanion?.dismiss();
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The engine (nekkod, or the TS backend alone); set once the app is ready. */
let engine: EngineProcess | null = null;
/** True once the engine has been stopped for quit, so the second quit goes through. */
let engineStopped = false;
import {
  TITLEBAR_HEIGHT,
  TITLEBAR_OVERLAY_CHANNEL,
  type TitleBarOverlayTheme,
} from '../windowChrome.js';

if (process.env.ELECTRON_RUN_AS_NODE) {
  // electron-vite spawns the binary with the caller's env, and this var turns
  // it into plain Node: no `app`, no BrowserWindow, and the first real API
  // call dies with a confusing stack. Say so
  // plainly instead.
  console.error('ELECTRON_RUN_AS_NODE is set: Nekko Agent must run as Electron, not Node. Unset it and retry.');
  process.exit(1);
}

app.setName('Nekko Agent');
registerDevLaunch(app);
const previousProfile = app.getPath('userData');
preservePackagedProfile(app);

/**
 * What the native buttons look like before the renderer has told us the theme.
 *
 * Dark `--paper` and `--ink-soft`, because the window is created with a dark
 * background and a light-themed overlay would flash white in the corner for
 * the frame or two before the page mounts.
 */
const DEFAULT_OVERLAY: TitleBarOverlayTheme = { color: '#0c0c11', symbolColor: '#a3a1b0' };

/**
 * The URL scheme other apps use to reach Nekko Agent
 * (`nekko-agent://hypergate/connect`).
 */
const PROTOCOLS = ['nekko-agent'] as const;

/**
 * An `nekko-agent://` URL waiting for a window to hand it to.
 *
 * A cold launch *from* a link arrives before the renderer exists, so the link
 * is parked here and replayed once the page says it is listening. Only the
 * newest is kept: these are commands, and a queue of stale ones fired at once
 * is not what anybody clicked.
 */
let pendingLink: string | null = null;

/** Pick an `nekko-agent://` URL out of a command line (Windows and Linux pass it as an argument). */
function linkFromArgv(argv: string[]): string | null {
  return argv.find((a) => PROTOCOLS.some((scheme) => a.startsWith(`${scheme}://`))) ?? null;
}

/**
 * Send a deep link to the window, or hold it until one is ready.
 *
 * Also raises the window: the point of the link is that the user clicked
 * something in *another* app and expects Nekko Agent to come forward and show them
 * the result.
 */
function deliverLink(url: string): void {
  trayCompanion?.dismiss();
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win || win.webContents.isLoading()) {
    pendingLink = url;
    if (!win) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(IpcEvents.deepLink, url);
}

/**
 * macOS keeps the system menu bar. Electron's default app menu is kept for
 * everything else, but its "Nekko Agent" menu gains Settings… (⌘,) and its
 * About item opens the in-app About page instead of the stock panel.
 */
function installMacAppMenu(): void {
  const send = (url: string) => () => deliverLink(url);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: send('nekko-agent://about') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: send('nekko-agent://settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

function resolveWindowIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../renderer/icon-512.png'),
    join(__dirname, '../renderer/public/icon-512.png'),
    join(__dirname, '../../src/renderer/public/icon-512.png'),
  ];
  return candidates.find((path) => existsSync(path));
}

/**
 * An app window: the whole UI, with the app's own title strip. The main window
 * and every multi-monitor screen window are made here, so they share the
 * preload, the navigation guards and the webview hardening.
 */
function newAppWindow(bounds: { x?: number; y?: number; width: number; height: number }, displayId?: string): BrowserWindow {
  return new BrowserWindow({
    ...bounds,
    // A screen window starts as a thin strip and swipes open, so it cannot
    // have the main window's floor.
    minWidth: displayId ? undefined : MIN_WINDOW.width,
    minHeight: displayId ? undefined : MIN_WINDOW.height,
    show: false,
    backgroundColor: DEFAULT_OVERLAY.color,
    icon: resolveWindowIcon(),
    // One bar, not three. The app draws its own title strip (see
    // `windowChrome.ts`), so the OS contributes buttons and nothing else: no
    // title bar and no File/Edit/View/Window strip stacked above the UI.
    titleBarStyle: 'hidden',
    // macOS keeps its traffic lights; centre them in our strip so they sit on
    // the wordmark's line. Windows and Linux get the Window Controls Overlay,
    // painted in the app's own background so the buttons read as part of the
    // page rather than as a frame around it.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: (TITLEBAR_HEIGHT - 16) / 2 } }
      : { titleBarOverlay: { ...DEFAULT_OVERLAY, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Enable <webview> for the in-app browser pane (BrowserPane).
      webviewTag: true,
      // Tells the preload which screen this window fills (multi-monitor).
      ...(displayId ? { additionalArguments: [`${DISPLAY_ARG}${displayId}`] } : {}),
    },
  });
}

/** Everything an app window's page needs, main window or screen window alike. */
function wireAppWindow(win: BrowserWindow): void {
  // Reload and devtools used to hang off the View menu. The menu is gone, the
  // shortcuts people reach for shouldn't be, so bind the two that were worth
  // keeping directly. Everything else in that menu duplicated a shortcut the
  // app already owns (see `shortcuts.ts`) or a gesture Chromium handles itself.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (key === 'f12' || (mod && input.shift && key === 'i')) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    } else if (mod && key === 'r') {
      event.preventDefault();
      win.webContents.reload();
    }
  });

  applicationWindows.add(win.webContents.id);
  const windowId = win.webContents.id;
  const forgetVisibility = () => { notificationSessions.delete(windowId); notificationViews.delete(windowId); };
  win.once('closed', () => { applicationWindows.delete(windowId); forgetVisibility(); });
  win.webContents.on('did-start-loading', forgetVisibility);
  win.webContents.on('render-process-gone', forgetVisibility);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    const sameApp = rendererUrl
      ? (() => {
          try {
            return new URL(url).origin === new URL(rendererUrl).origin;
          } catch {
            return false;
          }
        })()
      : (() => {
          if (!url.startsWith('file://')) return false;
          try {
            const target = resolve(fileURLToPath(url));
            const rendererDir = resolve(join(__dirname, '../renderer'));
            return target === rendererDir || target.startsWith(`${rendererDir}${sep}`);
          } catch {
            return false;
          }
        })();
    if (sameApp) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!/^https?:\/\//i.test(params.src) && params.src !== 'about:blank') {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** A multi-monitor screen window: the whole app on another screen, closed (not hidden) with its X. */
function createScreenWindow(displayId: string, bounds: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const win = newAppWindow(bounds, displayId);
  wireAppWindow(win);
  return win;
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) { showWindow(); return; }
  // A first launch is sized to the screen before the window exists, so it
  // appears at that size rather than visibly growing into it.
  const { maximized, ...bounds } = loadWindowBounds() ?? initialWindowBounds(screen.getPrimaryDisplay().workArea);
  const win = newAppWindow(bounds);

  mainWindow = win;
  win.once('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.on('ready-to-show', () => {
    if (maximized) win.maximize();
    win.show();
    // Without focus, Windows may leave a window opened from a terminal behind
    // others, flashing in the taskbar instead of coming to the front.
    win.focus();
  });
  const closeIntent = createCloseIntent();
  if (process.platform === 'win32') {
    win.hookWindowMessage(WM_SYSCOMMAND, (wParam) => closeIntent.sysCommand(readWParam(wParam)));
    win.hookWindowMessage(WM_CLOSE, () => closeIntent.closeMessage());
  }
  win.on('close', event => {
    const external = closeIntent.takeExternal();
    if (quitting || !desktopTray) return;
    event.preventDefault();
    // Another program asked the app to exit (`taskkill` without /F, as
    // `nekko-agent migrate` and installers do): quit for real, through the
    // clean engine shutdown, rather than hide into the tray.
    if (external) { app.quit(); return; }
    void trayCompanion?.closeWindow(() => { saveWindowBounds(win.isMaximized() ? { ...win.getNormalBounds(), maximized: true } : win.getBounds()); win.hide(); });
  });

  // A link that arrived before the page could listen (a cold launch from
  // Hypergate's Connect button) is replayed the moment it can.
  win.webContents.on('did-finish-load', () => {
    if (!pendingLink) return;
    const url = pendingLink;
    pendingLink = null;
    win.webContents.send(IpcEvents.deepLink, url);
  });

  // Persist size/position (debounced) so the window reopens where it was.
  let saveTimer: NodeJS.Timeout | undefined;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      // A maximised window keeps its restored size, so un-maximising next run still works.
      const maximized = win.isMaximized();
      saveWindowBounds({ ...(maximized ? win.getNormalBounds() : win.getBounds()), ...(maximized ? { maximized } : {}) });
      // Dragged onto another screen: that screen's own window (if any) goes,
      // and the old screen becomes switchable.
      displayWindows?.mainMoved();
    }, 400);
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);
  // Hidden to the tray: the other screens' windows go with it, and come back with it.
  win.on('hide', () => displayWindows?.setVisible(false));
  win.on('show', () => displayWindows?.setVisible(true));

  wireAppWindow(win);
}

/**
 * Multi-monitor: the screen windows and the channels the Screens dropdown and
 * new-agent placement use. Only app windows may call them.
 */
let displayWindows: DisplayWindows | null = null;
function registerDisplayWindows(dataDir: string): void {
  const windows = createDisplayWindows({
    screen,
    dataDir,
    mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    createWindow: (id, bounds) => createScreenWindow(id, bounds),
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && applicationWindows.has(win.webContents.id)) win.webContents.send(DISPLAYS_CHANGED_EVENT, state(win.webContents.id));
      }
    },
    placed: (key, sessionId) => {
      const target = key === MAIN_KEY ? mainWindow : windows.windowFor(key);
      if (target && !target.isDestroyed()) target.webContents.send(DISPLAYS_PLACED_EVENT, sessionId);
    },
  });
  displayWindows = windows;
  const trusted = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => applicationWindows.has(e.sender.id);
  ipcMain.handle(DISPLAYS_LIST_CHANNEL, (e) => { if (!trusted(e)) throw new Error('untrusted'); return windows.state(e.sender.id); });
  ipcMain.handle(DISPLAYS_TOGGLE_CHANNEL, (e, id: unknown, on: unknown, reducedMotion: unknown) => {
    if (!trusted(e) || typeof id !== 'string') throw new Error('bad request');
    windows.toggle(id, on === true, reducedMotion === true);
    return windows.state(e.sender.id);
  });
  ipcMain.handle(DISPLAYS_PLACEMENT_CHANNEL, (e, placement: unknown) => {
    if (!trusted(e)) throw new Error('untrusted');
    windows.setPlacement(placement === 'main-first' ? 'main-first' : 'empty-first');
    return windows.state(e.sender.id);
  });
  ipcMain.handle(DISPLAYS_CLAIM_CHANNEL, (e, sessionId: unknown, mode: unknown) => {
    if (!trusted(e) || typeof sessionId !== 'string') throw new Error('bad request');
    return windows.claim(e.sender.id, sessionId, mode === 'self' || mode === 'place' ? mode : 'auto');
  });
  ipcMain.on(DISPLAYS_REPORT_CHANNEL, (e, panes: unknown) => { if (trusted(e) && typeof panes === 'number') windows.report(e.sender.id, panes); });
  windows.start();
}

/**
 * Keep the native buttons the same colour as the strip they sit in.
 *
 * The renderer owns the theme (system, light, dark, plus a user accent), so it
 * is the only side that knows what `--paper` currently resolves to; without
 * this the buttons stay dark after the app goes light.
 */
function registerTitleBarOverlaySync(): void {
  ipcMain.on(TITLEBAR_OVERLAY_CHANNEL, (e, theme: TitleBarOverlayTheme) => {
    if (process.platform === 'darwin') return;
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      win?.setTitleBarOverlay({ ...theme, height: TITLEBAR_HEIGHT });
    } catch {
      /* the platform has no overlay to repaint */
    }
  });
}

/**
 * Register `nekko-agent://` with the OS and make sure a link reaches the app that
 * is already open.
 *
 * The single-instance lock is what makes that true: without it the OS answers
 * a link by starting a *second* Nekko Agent on the same data directory, two hosts
 * writing one settings file. With it, the second process hands its argument to
 * the first and exits. Returns false when another instance already holds the
 * lock, meaning this process should quit immediately.
 */
function claimSingleInstance(): boolean {
  // In development the executable is Electron itself, so the registration has
  // to name the script too or the OS would launch a bare Electron shell.
  for (const scheme of PROTOCOLS) {
    if (process.defaultApp) {
      if (process.argv.length >= 2) app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }

  if (!app.requestSingleInstanceLock()) return false;

  app.on('second-instance', (_e, argv) => {
    const link = linkFromArgv(argv);
    if (link) {
      deliverLink(link);
      return;
    }
    // Launched again without a link: the user asked for Nekko Agent, so show the
    // window they already have rather than doing nothing at all.
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });

  // macOS delivers links as an event, not as an argument, whether the app was
  // already running or was launched by the click.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverLink(url);
  });

  return true;
}

/** False in a second copy launched by a link; that one hands over and exits. */
const isPrimary = claimSingleInstance();
if (!isPrimary) app.quit();

app.whenReady().then(async () => {
  registerArtifactPreview((sender) => applicationWindows.has(sender.id));
  if (!isPrimary) return;
  // No File/Edit/View/Window bar: it cost a whole strip of chrome above the UI
  // to duplicate shortcuts the app already owns. macOS keeps its menu — there
  // it lives in the system bar rather than in the window, and ⌘Q/⌘H/⌘W come
  // from it.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  else installMacAppMenu();

  // Where user data lives is decided here, before the engine starts, because a
  // move from an older profile needs a native dialog and the user's answer.
  let dataDir = defaultUserDataDir();
  const devSource = join(previousProfile, 'nekko-agent');
  try {
    if (!brandEnv('DATA_DIR') && !existsSync(join(dataDir, 'settings.json')) && existsSync(join(devSource, 'settings.json'))) throw new Error('An existing desktop profile needs confirmation before moving.');
    dataDir = prepareUserDataRoot();
  } catch (e) {
    if (brandEnv('DATA_DIR')) throw e;
    const sources = [...new Set([...legacyUserDataDirs(undefined, app.getPath('appData')), ...(existsSync(join(devSource, 'settings.json')) ? [devSource] : [])])];
    if (!sources.length) { dialog.showErrorBox('Data migration needs attention', (e as Error).message); app.quit(); return; }
    const choice = dialog.showMessageBoxSync({ type: 'question', title: 'Move Nekko Agent data', message: 'Choose the profile to move into ~/.nekko-agent', detail: `Close all other Nekko Agent desktop, web and CLI instances first. Settings, sessions and managed model files will move to ${dataDir}. Borrowed model folders are unchanged. Other profiles are not merged or deleted.`, buttons: ['Cancel', ...sources.map(p => `Move ${p}`)], defaultId: 0, cancelId: 0, noLink: true });
    if (choice === 0) { app.quit(); return; }
    try {
      const source = sources[choice - 1];
      migrateUserData(source, dataDir, source.endsWith('nekko-agent') ? join(source, '..') : undefined);
    }
    catch (failure) { dialog.showErrorBox('Data migration stopped', (failure as Error).message); app.quit(); return; }
  }
  // Earlier names of the app leave their own folders behind. Offer to fold them
  // in on every launch while any remain; the engine is not running yet, so the
  // data folder is quiet.
  offerLegacyCleanup({
    dataDirOverridden: Boolean(brandEnv('DATA_DIR')),
    ask: (message, detail) => {
      const pick = dialog.showMessageBoxSync({ type: 'question', title: 'Nekko Agent', message, detail, buttons: ['Merge and clean up', 'Merge, keep old copies', 'Not now'], defaultId: 0, cancelId: 2, noLink: true });
      return pick === 0 ? 'merge-clean' : pick === 1 ? 'merge-keep' : 'later';
    },
    tell: (title, detail, error) => { dialog.showMessageBoxSync({ type: error ? 'warning' : 'info', title: 'Nekko Agent', message: title, detail, buttons: ['OK'] }); },
  });
  // Main's console, teed to `<dataDir>/logs/app.log` (appLog.ts); nekkod serves it as `logs:read('app')`.
  startAppLog(dataDir);
  // The engine runs in its own processes (see engine-process.ts); the window
  // only needs to know where it listens.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  // The bridge also carries what nekkod asks of the window shell: the app
  // window's handle for owning its dialogs, dialogs it cannot draw (macOS),
  // and quitting so an update can install.
  const agentBrowser = await startAgentBrowser({ pickFolder: pickFolderDialog, shell: shellBridge(() => app.quit()) });
  app.once('will-quit', () => agentBrowser.close());
  engine = new EngineProcess({
    browserBridge: { url: agentBrowser.url, token: agentBrowser.token },
    dataDir,
    app: {
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      version: app.getVersion(),
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      exePath: process.execPath,
      pid: process.pid,
    },
    // A packaged page is a file:// document: fetch reports its origin as
    // `null`, a WebSocket handshake as `file://`.
    origins: ['null', 'file://', ...(rendererUrl ? [new URL(rendererUrl).origin] : [])],
    mainDir: __dirname,
  });
  engine.start();
  nativeNotifications = createNativeNotificationPoster({
    isSupported: () => Notification.isSupported(),
    create: options => new Notification(options),
  }, url => { showWindow(); deliverLink(url); }, resolveWindowIcon());
  stopNotifications = startMainNotifications(engine, nativeNotifications.post, undefined, () => {
    const focused = BrowserWindow.getFocusedWindow();
    const owned = focused && applicationWindows.has(focused.webContents.id) ? focused : null;
    const id = owned?.webContents.id;
    return notificationWindowContext(owned, id != null ? notificationSessions.get(id) ?? null : null, id != null ? notificationViews.get(id) ?? null : null);
  });
  ipcMain.on(NOTIFICATION_VISIBILITY_CHANNEL, (event, report: unknown) => {
    if (!trustedNotificationReporter(applicationWindows.has(event.sender.id), event.senderFrame, event.sender.mainFrame)) return;
    notificationSessions.set(event.sender.id, visibleNotificationSession(report));
    notificationViews.set(event.sender.id, visibleNotificationView(report));
  });
  registerIpc(engine);
  setWindowStateDir(dataDir);
  registerTitleBarOverlaySync();
  // A link that launched the app is already on this process's command line
  // (Windows/Linux); park it so the first load replays it.
  pendingLink = linkFromArgv(process.argv);
  createWindow();
  registerDisplayWindows(dataDir);
  const iconPath = resolveWindowIcon();
  if (iconPath) {
    desktopTray = createDesktopTray({
      iconPath,
      engine,
      showUi: showWindow,
      newChat: () => deliverLink('nekko-agent://chat/new'),
      serviceStarted: () => { for (const win of BrowserWindow.getAllWindows()) win.webContents.reload(); },
      quit: () => app.quit(),
      onError: message => dialog.showErrorBox('Nekko Agent', message),
    });
    const service = engine;
    trayCompanion = createTrayCompanion({
      tray: desktopTray.tray,
      // A stopped service must not prevent hiding or shutting down the UI.
      settings: async () => service.running
        ? service.call<AppSettings>(IpcChannels.settingsGet)
        : JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as AppSettings,
      update: patch => service.call(IpcChannels.settingsUpdate, patch),
      serviceRunning: () => service.running,
      quit: () => app.quit(),
      onError: message => dialog.showErrorBox('Nekko Agent', message),
    });
  }

  // Under `npm run dev`, hand the launcher what it needs for its banner.
  void engine.call<ApiServerStatus>(IpcChannels.apiServerStatus)
    .then((s) => reportDevReady({ version: app.getVersion(), api: s ? { url: s.clientUrl, enabled: s.settings.enabled } : null, dataDir }))
    .catch(() => reportDevReady({ version: app.getVersion(), api: null, dataDir }));

  app.on('activate', () => {
    showWindow();
  });
});

app.on('window-all-closed', () => {
  // The engine (and the API server in it) deliberately survives this: on macOS
  // the app is still running with no window open, and a CLI or MCP client
  // pointed at it should not lose its connection because someone closed the
  // last window. Quitting takes it down, below.
  if (process.platform !== 'darwin' && !desktopTray) app.quit();
});

// Quitting waits for the engine to shut down cleanly (it marks the CLI link as
// not serving and stops model servers it started), then quits for real.
app.on('before-quit', (event) => {
  quitting = true;
  displayWindows?.dispose();
  trayCompanion?.dispose();
  stopNotifications?.();
  stopNotifications = undefined;
  nativeNotifications?.dispose();
  if (engineStopped || !engine) { desktopTray?.dispose(); desktopTray = null; return; }
  event.preventDefault();
  const stopping = engine;
  engine = null;
  void stopping.stop().finally(() => {
    engineStopped = true;
    app.quit();
  });
});
