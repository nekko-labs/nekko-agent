import { execFile } from 'child_process';

/**
 * macOS desktops (Spaces), read and switched without private APIs.
 *
 * The desktop list and the current desktop come from the `com.apple.spaces`
 * preferences (read through `defaults`, so cfprefsd's live copy, not a stale
 * file). Switching sends Mission Control's own shortcuts through System
 * Events: Ctrl+number when "Switch to Desktop n" is enabled, else Ctrl+arrow
 * steps. Sending keystrokes needs the Accessibility permission.
 */

/** Desktops on one screen, as `ManagedSpaceID` strings in Mission Control order. */
export interface Spaces { current: string | null; desktops: string[] }

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const spaceId = (v: unknown) => { const id = record(v).ManagedSpaceID; return typeof id === 'number' && Number.isFinite(id) ? String(id) : null; };

/**
 * The main screen's desktops from `SpacesDisplayConfiguration`. Full-screen
 * apps (type 4) are not desktops and are skipped. With "Displays have
 * separate Spaces" on, each screen has its own list; the one named `Main`
 * (or the first) is used.
 */
export function parseSpaces(config: unknown): Spaces | null {
  const monitors = record(record(config)['Management Data']).Monitors;
  if (!Array.isArray(monitors)) return null;
  const withSpaces = monitors.map(record).filter((m) => Array.isArray(m.Spaces));
  const monitor = withSpaces.find((m) => m['Display Identifier'] === 'Main') ?? withSpaces[0];
  if (!monitor) return null;
  const desktops = (monitor.Spaces as unknown[]).filter((s) => record(s).type === 0).map(spaceId).filter((id): id is string => id !== null);
  const current = spaceId(monitor['Current Space']);
  return { current: current && desktops.includes(current) ? current : null, desktops };
}

/** Key codes for 1-9 on the number row. */
const DIGIT_KEYS = [18, 19, 20, 21, 23, 22, 26, 28, 25];

/**
 * The AppleScript that moves from desktop `from` to `to` (1-based). `direct`:
 * the "Switch to Desktop n" shortcut is on, so one Ctrl+n jumps there;
 * otherwise Ctrl+Right/Left steps over (on by default in macOS).
 */
export function switchScript(from: number, to: number, direct: boolean): string | null {
  if (from === to || to < 1) return null;
  if (direct && to <= DIGIT_KEYS.length) return `tell application "System Events" to key code ${DIGIT_KEYS[to - 1]} using control down`;
  const key = to > from ? 124 : 123;
  const steps = Array.from({ length: Math.abs(to - from) }, () => `key code ${key} using control down`);
  return `tell application "System Events"\n${steps.join('\ndelay 0.35\n')}\nend tell`;
}

type Run = (file: string, args: string[]) => Promise<string>;
const run: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** The live desktop list, or null off macOS or when it cannot be read. */
export async function readSpaces(exec: Run = run): Promise<Spaces | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const json = await exec('/bin/sh', ['-c', 'defaults export com.apple.spaces - | plutil -extract SpacesDisplayConfiguration json -o - -']);
    return parseSpaces(JSON.parse(json));
  } catch { return null; }
}

/** Whether "Switch to Desktop n" (symbolic hot key 117 + n) is enabled. */
async function directShortcut(n: number, exec: Run): Promise<boolean> {
  if (n < 1 || n > DIGIT_KEYS.length) return false;
  try {
    const out = await exec('/bin/sh', ['-c', `defaults export com.apple.symbolichotkeys - | plutil -extract AppleSymbolicHotKeys.${117 + n}.enabled raw -o - -`]);
    return /^(true|1)\s*$/.test(out);
  } catch { return false; }
}

/** Switch desktops by keystroke; rejects without Accessibility. */
export async function switchDesktop(from: number, to: number, exec: Run = run): Promise<void> {
  const script = switchScript(from, to, await directShortcut(to, exec));
  if (script) await exec('osascript', ['-e', script]);
}
