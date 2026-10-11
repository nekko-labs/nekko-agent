/**
 * Tell a person closing the window apart from another program asking the app
 * to exit (Windows only).
 *
 * With the tray, closing the window only hides it. That is right for the close
 * button, Alt+F4 and the taskbar's "Close window", but wrong for `taskkill`
 * without `/F` (what `nekko-agent migrate` and installers send): the app hid,
 * kept running, and the caller waited out its grace period before killing it
 * hard, skipping the engine's clean shutdown.
 *
 * What arrives differs. A person's close reaches the window as WM_SYSCOMMAND
 * SC_CLOSE, which Windows turns into WM_CLOSE (or, for the drawn caption
 * button, as no WM_CLOSE at all). Another program posts a bare WM_CLOSE.
 */
export const WM_CLOSE = 0x0010;
export const WM_SYSCOMMAND = 0x0112;
export const SC_CLOSE = 0xf060;

export interface CloseIntent {
  /** Feed every WM_SYSCOMMAND's wParam. */
  sysCommand(wParam: number): void;
  /** Feed every WM_CLOSE. */
  closeMessage(): void;
  /** At the window's `close` event: was this close requested by another program? Resets. */
  takeExternal(): boolean;
}

export function createCloseIntent(): CloseIntent {
  let sysClose = false;
  let external = false;
  return {
    // The low four bits of an SC_* value are used by Windows internally.
    sysCommand(wParam) { if ((wParam & 0xfff0) === SC_CLOSE) sysClose = true; },
    closeMessage() { external = !sysClose; sysClose = false; },
    takeExternal() { const was = external; external = false; sysClose = false; return was; },
  };
}

/** wParam arrives as a pointer-sized Buffer. */
export function readWParam(buf: Buffer): number {
  return buf.length >= 4 ? buf.readUInt32LE(0) : 0;
}
