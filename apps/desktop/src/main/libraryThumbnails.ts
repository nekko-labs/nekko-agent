import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIBRARY_THUMBNAIL_CHANNELS } from '@nekko-agent/shared';

/** Largest total size of all cached thumbnails on disk (50 MiB). */
const MAX_DISK_BYTES = 50 * 1024 * 1024;
/** Maximum number of thumbnail files kept. */
const MAX_ENTRIES = 500;
/** Width of a thumbnail capture; matches FRAME.width in the renderer. */
const CAPTURE_WIDTH = 1440;
/** Height of a thumbnail capture; matches FRAME.height in the renderer. */
const CAPTURE_HEIGHT = 900;
/** Width of the stored thumbnail image. */
const THUMB_WIDTH = 400;
/** Milliseconds the hidden window waits before capturing, so the page has time to settle. */
const SETTLE_MS = 1800;
/** Hard timeout for a single capture (ms) so a stuck page never blocks the queue. */
const CAPTURE_TIMEOUT_MS = 15_000;
/** Maximum concurrent HTML captures (each opens a hidden BrowserWindow). */
const MAX_CONCURRENT_CAPTURES = 2;

export function thumbKey(path: string, revision: string | number): string {
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 32);
  const rev = String(revision).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || '0';
  return `${hash}_${rev}.webp`;
}

/**
 * Persistent on-disk thumbnail cache for Library files (#3043).
 *
 * Files are stored as small WebP images (or PNG for HTML captures) under
 * `{userData}/library-thumbs/`. On each put, the oldest files are evicted
 * when the store is over `MAX_ENTRIES` or `MAX_DISK_BYTES`.
 *
 * The `capture` handler requires a URL that the HTML preview server itself
 * issued and is still serving (`isPreviewServedUrl`). The hidden window is
 * hardened: navigation/redirects are blocked, window.open is denied,
 * permissions are denied, and all non-loopback network requests are blocked.
 * Concurrent captures are queued at `MAX_CONCURRENT_CAPTURES`.
 */
export function registerLibraryThumbnails(
  authorized: (sender: WebContents) => boolean,
  isPreviewServedUrl: (url: string) => boolean = () => false,
): void {
  const dir = join(app.getPath('userData'), 'library-thumbs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const check = (sender: WebContents, frame: unknown) => {
    if (!authorized(sender) || frame !== sender.mainFrame) throw new Error('Library thumbnails require the application main frame.');
  };

  // Lock down the shared capture session once at startup.
  // All windows in this partition share these restrictions.
  const captureSession = session.fromPartition('nekko-thumb-capture');
  captureSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  captureSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    // Allow only requests back to the same 127.0.0.1 origin (the preview server).
    callback({ cancel: !details.url.startsWith('http://127.0.0.1:') });
  });

  /** Evict oldest files when the store is over its limits. */
  function evict(): void {
    try {
      const files = readdirSync(dir)
        .filter(f => /\.(webp|png)$/.test(f))
        .map(name => {
          try { const s = statSync(join(dir, name)); return { name, mtime: s.mtimeMs, size: s.size }; }
          catch { return null; }
        })
        .filter(Boolean) as Array<{ name: string; mtime: number; size: number }>;
      files.sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((sum, f) => sum + f.size, 0);
      let count = files.length;
      let i = 0;
      while ((count > MAX_ENTRIES || total > MAX_DISK_BYTES) && i < files.length) {
        try { unlinkSync(join(dir, files[i].name)); total -= files[i].size; count--; } catch { /* already gone */ }
        i++;
      }
    } catch { /* non-fatal */ }
  }

  ipcMain.handle(LIBRARY_THUMBNAIL_CHANNELS.get, async (event, path: unknown, revision: unknown): Promise<string | null> => {
    check(event.sender, event.senderFrame);
    if (typeof path !== 'string' || (typeof revision !== 'string' && typeof revision !== 'number')) return null;
    try {
      // Try both extensions: png (HTML captures) and webp (document/image thumbnails).
      const base = thumbKey(path, revision).replace(/\.(webp|png)$/, '');
      for (const ext of ['png', 'webp'] as const) {
        const file = join(dir, `${base}.${ext}`);
        if (existsSync(file)) {
          const data = readFileSync(file);
          return `data:image/${ext};base64,${data.toString('base64')}`;
        }
      }
      return null;
    } catch { return null; }
  });

  ipcMain.handle(LIBRARY_THUMBNAIL_CHANNELS.put, async (event, path: unknown, revision: unknown, data: unknown) => {
    check(event.sender, event.senderFrame);
    if (typeof path !== 'string' || (typeof revision !== 'string' && typeof revision !== 'number') || typeof data !== 'string') return;
    try {
      const match = /^data:image\/(webp|png);base64,(.+)$/s.exec(data);
      if (!match) return;
      const [, ext, b64] = match;
      const filename = thumbKey(path, revision).replace(/\.(webp|png)$/, `.${ext}`);
      writeFileSync(join(dir, filename), Buffer.from(b64, 'base64'));
      evict();
    } catch { /* non-fatal */ }
  });

  // Concurrency queue: at most MAX_CONCURRENT_CAPTURES windows open at once.
  let activeCaptures = 0;
  const captureQueue: Array<() => void> = [];

  async function doCapture(url: string): Promise<string | null> {
    // One shared partition so Electron doesn't leak one per capture.
    const win = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      webPreferences: {
        partition: 'nekko-thumb-capture',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    try {
      // Deny window.open: the page must not spawn new windows.
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // Block navigation away from the served URL (redirects, link clicks).
      win.webContents.on('will-navigate', (e) => { e.preventDefault(); });
      win.webContents.on('will-redirect', (e) => { e.preventDefault(); });

      // Hard timeout: resolve null if the page takes too long.
      let resolved = false;
      const timeoutHandle = setTimeout(() => {
        resolved = true;
        if (!win.isDestroyed()) win.destroy();
      }, CAPTURE_TIMEOUT_MS);

      await win.loadURL(url);
      // Give the page time to paint (matches TilePreview's SETTLE_MS of 1200 ms plus a margin).
      await new Promise<void>(resolve => setTimeout(resolve, SETTLE_MS));
      clearTimeout(timeoutHandle);
      if (resolved || win.isDestroyed()) return null;

      const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false });
      if (image.isEmpty()) return null;
      const thumb = image.resize({ width: THUMB_WIDTH, quality: 'best' });
      return `data:image/png;base64,${thumb.toPNG().toString('base64')}`;
    } catch { return null; }
    finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  function queueCapture(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      const run = () => {
        activeCaptures++;
        doCapture(url).then(resolve).catch(() => resolve(null)).finally(() => {
          activeCaptures--;
          const next = captureQueue.shift();
          if (next) next();
        });
      };
      if (activeCaptures < MAX_CONCURRENT_CAPTURES) {
        run();
      } else {
        captureQueue.push(run);
      }
    });
  }

  ipcMain.handle(LIBRARY_THUMBNAIL_CHANNELS.capture, async (event, url: unknown): Promise<string | null> => {
    check(event.sender, event.senderFrame);
    if (typeof url !== 'string') return null;
    // Only capture a URL the HTML preview server itself issued and is currently serving.
    // This prevents the renderer from directing the hidden window at arbitrary URLs.
    if (!isPreviewServedUrl(url)) return null;
    return queueCapture(url);
  });
}
