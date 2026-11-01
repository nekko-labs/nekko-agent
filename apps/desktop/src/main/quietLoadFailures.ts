import type { WebContents } from 'electron';

/** net::ERR_ABORTED: Electron neither warns nor emits did-fail-load for it. */
const ERR_ABORTED = -3;

/** The URL whose failed load Electron is about to warn about, if it belongs to a quieted window. */
let expected: string | null = null;
let installed = false;

/**
 * Keep a window's failed page loads off the app console. Electron prints
 * "Failed to load URL: … with error: …" through process.emitWarning for every
 * failed navigation, listener or not (a `did-fail-load` listener does not stop
 * it). For a window whose caller already gets the failure back, such as the
 * agent's browser, that is noise. Electron fires did-fail-provisional-load,
 * the warning and did-fail-load synchronously in that order, so the URL armed
 * between the two events matches exactly the one warning they bracket; other
 * windows' load failures still print.
 */
export function quietLoadFailures(contents: WebContents): void {
  install();
  contents.on('did-fail-provisional-load', (_event, code, _description, url) => { expected = code === ERR_ABORTED ? null : url; });
  contents.on('did-fail-load', () => { expected = null; });
}

function install(): void {
  if (installed) return;
  installed = true;
  const emit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    if (expected !== null && rest[0] === 'electron' && typeof warning === 'string' && warning.startsWith(`Failed to load URL: ${expected} with error: `)) {
      expected = null;
      return;
    }
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
}
