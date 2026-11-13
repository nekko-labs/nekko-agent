import { HTML_PREVIEW_CHANNELS, type HtmlPreviewServed } from '@nekko-agent/shared';
import { createHtmlPreviewServer, HtmlPreviewRefusal, type HtmlPreviewServerOptions } from '@nekko-agent/profile/html-preview';

/**
 * The Local Web UI's answer to the HTML preview channels: pages are served on
 * a port of their own beside the UI (never on the UI's origin, which would
 * hand a page's scripts the API), at the host name the browser used to reach
 * the UI. Requests reach here through `/api/:channel`, behind the same token
 * and origin checks as every engine call.
 */
export function localHtmlPreview(options: HtmlPreviewServerOptions) {
  const server = createHtmlPreviewServer(options);
  return {
    async call(channel: string, args: unknown[], hostHeader: string | undefined): Promise<HtmlPreviewServed | null> {
      if (channel === HTML_PREVIEW_CHANNELS.release) {
        server.release(args[0] as string);
        return null;
      }
      const opts = args[1];
      const flag = (name: 'internet' | 'controls') => typeof opts === 'object' && opts !== null && (opts as Record<string, unknown>)[name] === true;
      let hostname: string;
      try {
        hostname = new URL(`http://${hostHeader ?? ''}`).hostname;
      } catch {
        throw new Error('The preview needs the address this page was opened at.');
      }
      if (!hostname) throw new Error('The preview needs the address this page was opened at.');
      try {
        const served = await server.serve(args[0] as string, { internet: flag('internet'), controls: flag('controls') });
        return { id: served.id, url: `http://${hostname}:${served.port}${served.path}` };
      } catch (e) {
        throw new Error(e instanceof HtmlPreviewRefusal ? e.message : 'The preview server could not start.');
      }
    },
    close: () => server.close(),
  };
}
