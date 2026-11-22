import { app, ipcMain, type WebContents } from 'electron';
import { HTML_PREVIEW_CHANNELS, type HtmlPreviewServed } from '@nekko-agent/shared';
import { createHtmlPreviewServer, HtmlPreviewRefusal } from '@nekko-agent/profile/html-preview';

/**
 * Local HTML pages served with their folder for the app's own frames (Library
 * and the file pane), on loopback only. The renderer frames the URL with
 * `sandbox="allow-scripts"`; the server's policy keeps the page off the
 * network unless the preview allowed it. See `@nekko-agent/profile/html-preview`.
 *
 * Returns a validator that the thumbnail capture handler uses to confirm a URL
 * was issued by this server and is still being served.
 */
export function registerHtmlPreview(authorized: (sender: WebContents) => boolean): (url: string) => boolean {
  const server = createHtmlPreviewServer({ host: '127.0.0.1' });
  let servedPort: number | undefined;

  const check = (sender: WebContents, frame: unknown) => {
    if (!authorized(sender) || frame !== sender.mainFrame) throw new Error('Preview requires the application main frame.');
  };
  ipcMain.handle(HTML_PREVIEW_CHANNELS.serve, async (event, path: unknown, options: unknown): Promise<HtmlPreviewServed> => {
    check(event.sender, event.senderFrame);
    const flag = (name: 'internet' | 'controls' | 'edit') => typeof options === 'object' && options !== null && (options as Record<string, unknown>)[name] === true;
    try {
      const served = await server.serve(path as string, { internet: flag('internet'), controls: flag('controls'), edit: flag('edit') });
      servedPort = served.port;
      return { id: served.id, url: `http://127.0.0.1:${served.port}${served.path}` };
    } catch (e) {
      throw new Error(e instanceof HtmlPreviewRefusal ? e.message : 'The preview server could not start.');
    }
  });
  ipcMain.handle(HTML_PREVIEW_CHANNELS.release, async (event, id: unknown) => {
    check(event.sender, event.senderFrame);
    server.release(id as string);
  });
  app.once('will-quit', () => { void server.close(); });

  /**
   * Returns true only when `url` was issued by this server and the page is
   * still in the served-pages set (not yet released or evicted).
   */
  return (url: string): boolean => {
    if (servedPort === undefined) return false;
    const prefix = `http://127.0.0.1:${servedPort}/`;
    if (!url.startsWith(prefix)) return false;
    const id = url.slice(prefix.length).split('/')[0];
    return id.length > 0 && server.hasPage(id);
  };
}
