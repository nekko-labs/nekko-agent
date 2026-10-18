import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const MAX_FRAME = 1_048_576;
/** One owned process, no command arguments, capability only on inherited stdin. */
export class AgentNativeClient {
  private readonly capability = randomBytes(32).toString('hex');
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private sequence = 0;
  private stopped = false;
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });

  constructor(binary: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
    this.child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const timer = setTimeout(() => this.fail(new Error('Native browser startup timed out.')), 15_000);
    this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Never forward native diagnostics into chat or protocol output.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('Native browser input closed.')));
    this.child.on('error', () => this.fail(new Error('Native browser could not start. Build the pinned native resource first.')));
    this.child.on('exit', () => this.fail(new Error('Native browser disconnected.')));
    this.child.stdin.write(JSON.stringify({ type: 'hello', protocol: 1, capability: this.capability }) + '\n');
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) { this.fail(new Error('Native browser response exceeded limit.')); return; }
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'ready' && frame.protocol === 1) { this.readyResolve(); continue; }
        const waiter = this.pending.get(frame.id);
        if (!waiter) throw new Error('Unexpected native response.');
        this.pending.delete(frame.id); clearTimeout(waiter.timer);
        if (frame.success === true) waiter.resolve(frame.data);
        else waiter.reject(new Error(typeof frame.error === 'string' ? frame.error : 'Native browser action failed.'));
      } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid native response.')); return; }
    }
  }

  async command(action: string, fields: Record<string, unknown> = {}, timeout = 28_000): Promise<any> {
    await this.ready;
    if (this.stopped) throw new Error('Native browser is closed.');
    const id = String(++this.sequence);
    const frame = JSON.stringify({ type: 'request', capability: this.capability, command: { ...fields, id, action } }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('Native browser request exceeded limit.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Native browser action timed out.')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame);
    });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true; this.readyReject(error);
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear(); this.child.kill();
  }
  close(): void { this.fail(new Error('Native browser closed.')); }
}
