import { BrowserWindow, desktopCapturer } from 'electron';
import { hwndFromSourceId, printWindowCapture, type PrintWindowResult } from './printWindowCapture.js';

/** Raised inside the recorder page when WGC refuses the window, so the fallback can tell it apart. */
const REFUSED_MARKER = 'NEKKO_CAPTURE_REFUSED';
const REFUSED_MESSAGE = 'The OS refused to capture the selected window; it may be elevated, protected or closed';
let printWindow: (hwnd: string) => Promise<PrintWindowResult> = (hwnd) => printWindowCapture(hwnd);
/** Tests only. */
export function __setPrintWindow(fn: (hwnd: string) => Promise<PrintWindowResult>): void { printWindow = fn; }

const selections = new Map<string, Map<string, string>>();
let recording = false;

/** Window-only capture. Source capabilities are scoped to the requesting chat. */
export async function captureWindow(sessionId: string, input: Record<string, unknown>, recorderUrl?: string, ownedWindow?: BrowserWindow): Promise<unknown> {
  const action = input.action;
  if (!['list', 'screenshot', 'record'].includes(String(action))) throw new Error('Invalid capture action');
  if (action === 'list') {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const windows = sources.map((s) => ({ id: s.id, title: s.name }));
    if (ownedWindow && !ownedWindow.isDestroyed()) windows.push({ id: `nekko:${ownedWindow.id}`, title: 'Nekko Browser (owned by this chat)' });
    selections.set(sessionId, new Map(windows.map((s) => [s.id, s.title])));
    return { windows };
  }
  const id = String(input.window_id ?? '');
  const title = selections.get(sessionId)?.get(id);
  if (!title) throw new Error('List windows first and select an id belonging to this chat');
  if (id.startsWith('nekko:')) {
    if (!ownedWindow || ownedWindow.isDestroyed() || id !== `nekko:${ownedWindow.id}`) throw new Error('Owned window disappeared; list windows again');
    if (action !== 'screenshot') throw new Error('Hidden owned windows support PNG screenshots only; recordings require an OS-listed window');
    const image = await ownedWindow.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw new Error('Owned window did not produce a frame; retry after the page finishes rendering');
    return { title, window_id: id, capturedAt: Date.now(), ...image.getSize(), mime: 'image/png', data: image.toPNG().toString('base64'), source: 'owned-page', background: true };
  }
  const seconds = Number(input.seconds ?? 5);
  if (action === 'record' && (!Number.isFinite(seconds) || seconds < 1 || seconds > 15)) throw new Error('Recording duration must be 1–15 seconds');
  if (recording) throw new Error('Another window capture is in progress');
  if (!recorderUrl || !recorderUrl.startsWith('http://127.0.0.1:')) throw new Error('Local recorder page is unavailable');
  recording = true;
  let win: BrowserWindow | undefined;
  try {
    // One shared in-memory partition: Electron never frees a partition's
    // session, so a fresh one per capture leaked. `recording` serializes
    // captures and the finally block clears the grant, so sharing is safe.
    win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1, height: 1, webPreferences: { partition: 'nekko-capture', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })).find((s) => s.id === id && s.name === title);
    if (!source) throw new Error('Selected window disappeared; list windows again');
    // Only this isolated, temporary recorder gets a display-media grant. It
    // never opens remote content, exposes a preload, or requests audio.
    win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source }));
    await win.loadURL(recorderUrl);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const acquire = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      let acquisitionTimer;
      let expired = false;
      acquire.then(stream => { if (expired) stream.getTracks().forEach(t => t.stop()); }, () => {});
      const stream = await Promise.race([acquire, new Promise((_, reject) => { acquisitionTimer = setTimeout(() => { expired = true; reject(new Error('OS window capture did not start within 5 seconds; no window was restored or focused')); }, 5000); })]).finally(() => clearTimeout(acquisitionTimer));
      try {
        const track = stream.getVideoTracks()[0];
        if (${action === 'screenshot'}) {
          const video = document.createElement('video');
          video.muted = true;
          video.srcObject = stream;
          let frameTimer;
          try {
            await Promise.race([
              new Promise((resolve, reject) => {
                track.onended = () => reject(new Error('Selected window could not be captured in the background; no window was restored or focused'));
                video.requestVideoFrameCallback(() => resolve());
                video.play().catch(reject);
              }),
              new Promise((_, reject) => { frameTimer = setTimeout(() => reject(new Error('Selected window did not produce a frame within 5 seconds; no window was restored or focused')), 5000); })
            ]);
            const width = video.videoWidth, height = video.videoHeight;
            if (!width || !height) throw new Error('Selected window produced an empty frame');
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(video, 0, 0);
            return { data: canvas.toDataURL('image/png').split(',')[1], width, height };
          } finally { clearTimeout(frameTimer); video.pause(); video.srcObject = null; }
        }
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 2000000 });
        const chunks = [];
        const blob = await new Promise((resolve, reject) => {
          let bytes = 0;
          const timer = setTimeout(() => recorder.stop(), ${seconds * 1000});
          recorder.ondataavailable = (e) => { bytes += e.data.size; if (bytes > 20 * 1024 * 1024) { clearTimeout(timer); recorder.stop(); reject(new Error('Recording exceeds 20 MB limit')); } else chunks.push(e.data); };
          recorder.onerror = () => { clearTimeout(timer); reject(new Error('Window recording failed')); };
          track.onended = () => { clearTimeout(timer); if (recorder.state !== 'inactive') recorder.stop(); reject(new Error('Capture source ended during recording')); };
          recorder.onstop = () => { clearTimeout(timer); resolve(new Blob(chunks, { type: 'video/webm' })); };
          recorder.start(250);
        });
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not encode recording')); reader.readAsDataURL(blob); });
        const { width, height } = track.getSettings();
        return { data, width, height };
      } finally { stream.getTracks().forEach(t => t.stop()); }
    })().catch(e => { throw new Error(e && e.name === 'NotReadableError' ? '${REFUSED_MARKER}' : String(e && e.message || e)); })`, true).catch(async (e: Error) => {
      // Windows Graphics Capture refuses some ordinary windows (Windows
      // Terminal among them). For a screenshot, GDI PrintWindow can still
      // render them in the background; it keeps every deliberate refusal.
      if (!String(e?.message).includes(REFUSED_MARKER)) throw e;
      const hwnd = action === 'screenshot' && process.platform === 'win32' ? hwndFromSourceId(id) : null;
      if (!hwnd) throw new Error(action === 'record' ? `${REFUSED_MESSAGE}. Recording has no background fallback; a screenshot may still work` : REFUSED_MESSAGE);
      const fallback = await printWindow(hwnd);
      if (!fallback.ok) throw new Error(fallback.message);
      return { data: fallback.data, width: fallback.width, height: fallback.height, fallback: true };
    });
    const { fallback, ...frame } = result as { fallback?: boolean; data: string; width: number; height: number };
    return { ...frame, title, window_id: id, capturedAt: Date.now(), ...(action === 'screenshot' ? { mime: 'image/png', source: fallback ? 'native-window-printwindow' : 'native-window', background: true } : { seconds, mime: 'video/webm' }) };
  } finally {
    try {
      if (win && !win.isDestroyed()) {
        try { win.webContents.session.setDisplayMediaRequestHandler(null); }
        finally { win.destroy(); }
      }
    } finally { recording = false; }
  }
}
