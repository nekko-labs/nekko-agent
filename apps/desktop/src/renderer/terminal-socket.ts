import type { TerminalStream, TerminalStreamHandlers } from '@nekko-agent/shared';

/**
 * One terminal's binary stream on nekkod's `/api/term/:id` socket, for the web
 * edition (the desktop preload has its own copy in `preload/engine-socket.ts`,
 * which cannot import renderer code).
 *
 * Server to client: binary frames are output, text frames are JSON control
 * messages (`hello` first, `exit` last). Client to server: one opcode byte,
 * then `0` input bytes, `1` cols and rows as big-endian u16s, `2` an ack of
 * parsed bytes as a big-endian u32 (the daemon's flow control).
 */

const OP_INPUT = 0;
const OP_RESIZE = 1;
const OP_ACK = 2;

export function openTerminalSocket(url: string, h: TerminalStreamHandlers): TerminalStream {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const outbox: Uint8Array<ArrayBuffer>[] = [];
  let closedByUs = false;
  const frame = (op: number, body: Uint8Array) => {
    const f = new Uint8Array(body.length + 1);
    f[0] = op;
    f.set(body, 1);
    if (ws.readyState === WebSocket.OPEN) ws.send(f);
    else if (ws.readyState === WebSocket.CONNECTING) outbox.push(f);
  };
  ws.onopen = () => outbox.splice(0).forEach((f) => ws.send(f));
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'hello') h.onHello?.(m);
        else if (m.type === 'exit') h.onExit?.(m.code ?? null);
      } catch {
        /* not a control frame we know */
      }
      return;
    }
    h.onData(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onclose = () => {
    if (!closedByUs) h.onClose?.();
  };
  const encoder = new TextEncoder();
  return {
    write: (data: string) => frame(OP_INPUT, encoder.encode(data)),
    resize: (cols: number, rows: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint16(0, cols);
      new DataView(b.buffer).setUint16(2, rows);
      frame(OP_RESIZE, b);
    },
    ack: (bytes: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, bytes >>> 0);
      frame(OP_ACK, b);
    },
    close: () => {
      closedByUs = true;
      ws.close();
    },
  };
}
