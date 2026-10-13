import { IpcEvents, deriveKey, seal, open, type RemoteHelloReply } from '@nekko-agent/shared';
import { createDispatcher } from './dispatch.js';
import type { Host } from './host.js';

export interface RelayAgentOptions {
  relayUrl: string;
  room: string;
  key: string;
  /** Access token for gated (managed) relays; sent as `&access=`. */
  access?: string;
  /**
   * Device auth: validate an E2E HELLO against the paired-device registry.
   * Every connection must be welcomed before a single request is served.
   */
  verify: (hello: unknown) => RemoteHelloReply;
}

export interface RelayAgentHandle {
  stop(): void;
  /** Kick a device's live connections and drop its push token (revocation). */
  kickDevice(deviceId: string): void;
  /** Device ids with a welcomed live connection. */
  connectedDevices(): string[];
  isOnline(): boolean;
  lastError(): string | undefined;
}

/**
 * Expose an existing Host over a relay as an "agent": dial OUT to the relay,
 * answer encrypted requests, and stream host events back. Lets a paired phone
 * drive this machine's model + tools with no inbound ports. Traffic is
 * end-to-end encrypted (the relay only sees ciphertext) and every connection is
 * gated behind the device HELLO handshake: requests from un-welcomed
 * connections are ignored, denied connections are kicked, and replies + events
 * are unicast per device so no client ever receives another's traffic.
 * Reconnects on drop until stop() is called.
 */
export function connectRelayAgent(host: Host, opts: RelayAgentOptions): RelayAgentHandle {
  const dispatch = createDispatcher(host);
  const keyP = deriveKey(opts.key, opts.room);
  const url =
    `${opts.relayUrl.replace(/\/$/, '')}/relay?role=agent` +
    `&room=${encodeURIComponent(opts.room)}&key=${encodeURIComponent(opts.key)}` +
    (opts.access ? `&access=${encodeURIComponent(opts.access)}` : '');

  let ws: WebSocket | null = null;
  let stopped = false;
  let online = false;
  let lastError: string | undefined;
  /** Live connections: cid → welcomed device id (set only after a valid HELLO). */
  const conns = new Map<string, { deviceId?: string }>();

  const sendRaw = (obj: unknown) => {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {
      /* closing */
    }
  };
  /**
   * Sealing is async (WebCrypto), and a streamed reply emits one event per
   * token. Sealing each frame independently let a later, smaller frame finish
   * first, so phones could receive "from your Hello computer.". Every outgoing
   * sealed frame goes through this queue: seals still start immediately, but
   * frames are written to the socket strictly in the order they were sent.
   */
  let outbox: Promise<void> = Promise.resolve();
  const enqueue = (sealed: Promise<string>, write: (data: string) => void): Promise<void> => {
    const sent = outbox.then(() => sealed).then(write, () => {
      /* sealing failed (e.g. key derivation): drop this frame, keep the queue alive */
    });
    outbox = sent;
    return sent;
  };
  const sealFrame = async (frame: unknown) => JSON.stringify({ enc: await seal(await keyP, frame) });
  const sendTo = (cid: string, frame: unknown) =>
    enqueue(sealFrame(frame), (data) => sendRaw({ type: 'd', cid, data }));
  /** Fan an event out to every welcomed connection (one seal per event). */
  const broadcast = (frame: unknown) => {
    if (![...conns.values()].some((c) => c.deviceId)) return Promise.resolve();
    return enqueue(sealFrame(frame), (data) => {
      // Recipients are read at write time, so a device revoked meanwhile gets nothing.
      for (const [cid, c] of conns) if (c.deviceId) sendRaw({ type: 'd', cid, data });
    });
  };

  const onAgent = (e: unknown) => {
    void broadcast({ type: 'event', channel: IpcEvents.agentEvent, payload: e });
    // On run completion, ping the relay (plain, content-free control frame) so it
    // can push a notification to a paired phone that's currently offline.
    if ((e as { type?: string })?.type === 'done') {
      sendRaw({ type: 'notify', title: 'Nekko finished', body: 'Your task is ready.' });
    }
  };
  const onIndex = (s: unknown) => void broadcast({ type: 'event', channel: IpcEvents.indexProgress, payload: s });
  const onTerminal = (e: unknown) => void broadcast({ type: 'event', channel: IpcEvents.terminalEvent, payload: e });
  const onChanges = (e: unknown) => void broadcast({ type: 'event', channel: IpcEvents.changesUpdated, payload: e });
  const onTasks = (t: unknown) => void broadcast({ type: 'event', channel: IpcEvents.tasksUpdated, payload: t });
  const onTraining = (r: unknown) => void broadcast({ type: 'event', channel: IpcEvents.trainingUpdated, payload: r });
  const onWorkflows = (s: unknown) => void broadcast({ type: 'event', channel: IpcEvents.workflowsUpdated, payload: s });
  const onLimits = (e: unknown) => void broadcast({ type: 'event', channel: IpcEvents.limitsUpdated, payload: e });
  host.events.on('agentEvent', onAgent);
  host.events.on('indexProgress', onIndex);
  host.events.on('terminalEvent', onTerminal);
  host.events.on('changesUpdated', onChanges);
  host.events.on('tasksUpdated', onTasks);
  host.events.on('trainingUpdated', onTraining);
  host.events.on('workflowsUpdated', onWorkflows);
  host.events.on('limitsUpdated', onLimits);

  const handleClientFrame = async (cid: string, data: string) => {
    let envelope: { enc?: string };
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }
    if (!envelope.enc) return;
    let frame: any;
    try {
      frame = await open(await keyP, envelope.enc);
    } catch {
      return; // wrong key / tampered
    }
    const conn = conns.get(cid) ?? {};
    conns.set(cid, conn);

    if (frame.type === 'hello') {
      const reply = opts.verify(frame);
      if (reply.type === 'welcome') {
        conn.deviceId = reply.device.id;
        await sendTo(cid, reply);
      } else {
        await sendTo(cid, reply);
        sendRaw({ type: 'kick', cid });
      }
      return;
    }
    if (frame.type !== 'req') return;
    if (!conn.deviceId) {
      // No completed handshake → never dispatch. Tell the client why.
      await sendTo(cid, { type: 'res', id: frame.id, error: 'not paired (send hello first)' });
      return;
    }
    try {
      const result = await dispatch(frame.channel, frame.args ?? []);
      await sendTo(cid, { type: 'res', id: frame.id, result: result ?? null });
    } catch (e) {
      await sendTo(cid, { type: 'res', id: frame.id, error: (e as Error).message });
    }
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      online = true;
      lastError = undefined;
    };
    ws.onmessage = async (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'client-open':
          conns.set(String(msg.cid), {});
          return;
        case 'client-close':
          conns.delete(String(msg.cid));
          return;
        case 'c':
          if (typeof msg.cid === 'string' && typeof msg.data === 'string') {
            await handleClientFrame(msg.cid, msg.data);
          }
          return;
        default:
          return;
      }
    };
    ws.onclose = (event) => {
      online = false;
      lastError = event.reason ? String(event.reason) : `relay disconnected (code ${event.code})`;
      conns.clear();
      if (!stopped) setTimeout(connect, 2000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return {
    stop() {
      stopped = true;
      host.events.off('agentEvent', onAgent);
      host.events.off('indexProgress', onIndex);
      host.events.off('terminalEvent', onTerminal);
      host.events.off('changesUpdated', onChanges);
      host.events.off('tasksUpdated', onTasks);
      host.events.off('trainingUpdated', onTraining);
      host.events.off('workflowsUpdated', onWorkflows);
      host.events.off('limitsUpdated', onLimits);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    kickDevice(deviceId) {
      for (const [cid, c] of conns) {
        if (c.deviceId === deviceId) sendRaw({ type: 'kick', cid });
      }
      sendRaw({ type: 'push-remove', deviceId });
    },
    connectedDevices() {
      return [...new Set([...conns.values()].map((c) => c.deviceId).filter((d): d is string => !!d))];
    },
    isOnline: () => online,
    lastError: () => lastError,
  };
}
