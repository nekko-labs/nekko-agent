import { hasAppChrome, isMacChrome } from '../chrome.js';
import { UpdateControl } from './UpdateBanner.js';
import { DeveloperServerControls } from './DeveloperServerControls.js';
import { BrandMark } from './BrandMark.js';
import { useStore } from '../store.js';
import { useT } from '../i18n.js';

/**
 * The window's title bar, drawn by the app.
 *
 * One strip in the app's own background colour: the brand mark at the leading
 * edge, then the current view's heading and the version, empty space the rest
 * of the way, and the OS buttons landing in that space rather than in a frame
 * of their own. Dragging it moves the window and double-clicking it maximises,
 * both handled by Chromium through the `app-region` rules in `styles.css`.
 *
 * The mark stands alone here, carrying the name as its accessible label; the rail keeps
 * mark and wordmark for the web and phone builds, which have no strip.
 *
 * Renders nothing outside the desktop shell.
 */
export function TitleBar() {
  const view = useStore((s) => s.view);
  const t = useT();
  if (!hasAppChrome) return null;
  return (
    <div className={`titlebar ${isMacChrome ? 'titlebar-mac' : ''}`}>
      <BrandMark size={28} className="titlebar-mark" title="Nekko Agent" />
      <h1 className="titlebar-heading text-gradient">{t(`nav.${view}`)}</h1>
      <UpdateControl />
      {/* Layout controls follow the heading and version in the same row. */}
      <div id="command-titlebar-slot" className="ml-4 flex min-w-0 flex-1 items-center gap-3" />
      <DeveloperServerControls />
    </div>
  );
}
