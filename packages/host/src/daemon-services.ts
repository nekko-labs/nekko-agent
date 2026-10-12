import { daemonCall, daemonOwns } from './engine/daemon.js';

/**
 * Services the engine daemon has taken over (PF14). When the daemon owns a
 * service (it says so in `NEKKOD_OWNS`, as it does for `settings`) it also
 * owns the service's files and timers, so this host must neither write them
 * nor run the service beside it: calls made inside this process (the local API
 * server, the CLI) go to the daemon, and the service's own loop does not start
 * here. Without a daemon (the CLI's in-process host, the cloud,
 * `NEKKO_DAEMON=ts`) everything stays local.
 */

/** Run `channel` on the daemon when it owns `what`, else `local()`. */
export async function viaDaemon<T>(what: string, channel: string, args: unknown[], local: () => T | Promise<T>): Promise<T> {
  const call = daemonOwns(what) ? daemonCall() : undefined;
  return call ? call<T>(channel, ...args) : local();
}

/** Start a service here unless the daemon owns it, and so runs it. */
export function unlessDaemonOwns(what: string, start: () => void): void {
  if (!daemonOwns(what)) start();
}
