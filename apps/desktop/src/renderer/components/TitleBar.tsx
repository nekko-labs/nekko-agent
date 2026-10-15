import { hasAppChrome, isMacChrome } from '../chrome.js';
import { UpdateControl } from './UpdateBanner.js';
import { DeveloperServerControls } from './DeveloperServerControls.js';
import { BrandMark } from './BrandMark.js';

/**
 * The window's title bar, drawn by the app.
 *
 * One strip in the app's own background colour: the wordmark at the leading
 * edge, empty space the rest of the way, and the OS buttons landing in that
 * space rather than in a frame of their own. Dragging it moves the window and
 * double-clicking it maximises, both handled by Chromium through the
 * `app-region` rules in `styles.css`.
 *
 * The wordmark lives here rather than in the rail so it isn't shown twice; the
 * rail keeps it for the web and phone builds, which have no strip to put it in.
 *
 * Renders nothing outside the desktop shell.
 */
export function TitleBar() {
  if (!hasAppChrome) return null;
  return (
    <div className={`titlebar ${isMacChrome ? 'titlebar-mac' : ''}`}>
      <span className="titlebar-word"><BrandMark size={16} className="titlebar-mark" />Agent Nekko</span>
      <div id="command-titlebar-title" className="no-drag ml-4 shrink-0" />
      <UpdateControl />
      <div id="command-titlebar-slot" className="no-drag ml-4 flex min-w-0 flex-1 items-center pr-[150px]" />
      <DeveloperServerControls />
    </div>
  );
}
