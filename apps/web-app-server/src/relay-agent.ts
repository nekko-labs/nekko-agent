import { daemonRequest, startNekkod } from 'nekko-agent/engine';

/**
 * Relay-agent mode for the server CLI: start nekkod on the data directory and
 * point its relay agent (crates/nekko-remote, the same one the desktop's
 * remote access uses) at a relay room, so headless agents get the same device
 * registry, pairing codes and revocation. Prints a one-time pairing code at
 * boot; more devices can be paired later from the UI (or by restarting). Runs
 * until stopped; nekkod and its backend stop with it.
 */
export async function runRelayAgent(opts: { relayUrl: string; room: string; key: string; dataDir: string; here: string; script: string }): Promise<void> {
  const { daemon } = await startNekkod({ here: opts.here, script: opts.script, dataDir: opts.dataDir });
  const stop = () => void daemon.stop().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await daemonRequest(daemon, 'remote:attach', { relayUrl: opts.relayUrl, room: opts.room, secret: opts.key });
    const grant = await daemonRequest<{ code: string }>(daemon, 'remote:pair');
    console.log(`\nNekko Agent relay-agent → ${opts.relayUrl}`);
    console.log(`   room=${opts.room}  key=${opts.key}`);
    console.log(`   one-time pairing code (10 min): ${grant.code}`);
    console.log(`   pairing link: <ui-origin>/?relay=${encodeURIComponent(opts.relayUrl)}&room=${opts.room}&key=${opts.key}&pair=${grant.code}`);
    console.log(`   serving this machine's model + tools to paired devices (data: ${opts.dataDir})\n`);
  } catch (e) {
    await daemon.stop();
    throw e;
  }
}
