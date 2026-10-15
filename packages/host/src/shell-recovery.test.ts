import * as childProcess from 'child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataDir } from './paths.js';
import { getSettings } from './store.js';
import { executeTool } from './tools.js';

// Copy the native namespace so vi spies can replace configurable exports, while
// restoring the actual implementations for the real-command tests below.
vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('child_process')>('child_process') }));

const nativePlatform = process.platform;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-shell-recovery-'));
  setDataDir(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function execute(command = 'echo recovery', signal?: AbortSignal) {
  return executeTool({ id: 'shell-recovery', name: 'bash', input: { command } }, {
    settings: getSettings(), defaultCwd: dir, mode: 'yolo', signal,
    requestApproval: async () => false,
  });
}

function mockWindowsShell() {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null, stdin: new PassThrough(),
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const end = vi.spyOn(child.stdin, 'end');
  const killer = new EventEmitter();
  let callback!: (error: Error | null, stdout: string, stderr: string) => void;
  const exec = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
    callback = args[3] as typeof callback;
    return child;
  }) as typeof childProcess.execFile);
  const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(killer as childProcess.ChildProcess);
  return { child, end, exec, spawn, close: (error: Error | null = null, stdout = '', stderr = '') => callback(error, stdout, stderr) };
}

describe('Windows shell recovery with stalled close callbacks', () => {
  beforeEach(() => vi.useFakeTimers());

  it('closes execFile stdin immediately and clears the deadline on normal completion', async () => {
    const shell = mockWindowsShell();
    const result = execute();
    expect(shell.exec).toHaveBeenCalledWith(
      process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'echo recovery'],
      expect.objectContaining({ encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }),
      expect.any(Function),
    );
    expect(shell.end).toHaveBeenCalledTimes(1);
    expect(shell.child.stdin.writableEnded).toBe(true);
    shell.close(null, 'done', 'warning');
    expect(await result).toMatchObject({ output: 'done\n[stderr]\nwarning' });
    await vi.advanceTimersByTimeAsync(125_000);
    expect(shell.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'cancel'] as const)('%s kills the tree and settles within five seconds without a close callback', async (reason) => {
    const shell = mockWindowsShell();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const settled = vi.fn();
    const result = execute('echo recovery', controller.signal).then(value => { settled(value); return value; });
    shell.child.stdout.emit('data', Buffer.from('partial stdout\n'));
    shell.child.stderr.emit('data', 'partial stderr\n');
    if (reason === 'timeout') {
      await vi.advanceTimersByTimeAsync(119_999);
      expect(shell.spawn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } else {
      controller.abort();
    }
    expect(shell.spawn).toHaveBeenCalledExactlyOnceWith('taskkill', ['/T', '/F', '/PID', '4242'], { windowsHide: true, stdio: 'ignore' });
    expect(settled).not.toHaveBeenCalled();
    // Output arriving while tree cleanup is in progress must survive too.
    shell.child.stdout.emit('data', 'during grace\n');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const value = await result;
    expect(value).toMatchObject({ isError: true });
    expect(value.output).toContain(reason === 'timeout' ? 'Command timed out.' : 'Command cancelled.');
    expect(value.output).toContain('partial stdout\nduring grace\npartial stderr\n');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(shell.child.stdin.destroyed).toBe(true);
    expect(shell.child.stdout.destroyed).toBe(true);
    expect(shell.child.stderr.destroyed).toBe(true);
    // A late execFile callback must neither replace the failure nor finish twice.
    shell.close(null, 'late success', 'late error');
    controller.abort();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await result).toBe(value);
    expect(value.output).not.toContain('late success');
    expect(shell.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['stdout', 'stderr'] as const)('bounds partial %s when forced cleanup supplies the result', async (stream) => {
    const shell = mockWindowsShell();
    const controller = new AbortController();
    const result = execute('echo recovery', controller.signal);
    shell.child[stream].emit('data', 'START-' + 'x'.repeat(100_000) + '-DISCARDED');
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    const value = await result;
    expect(value).toMatchObject({ isError: true });
    expect(value.output).toContain('START-');
    expect(value.output.length).toBe(60_000);
    expect(value.output).not.toContain('DISCARDED');
  });

  it('finishes early if close arrives during cancellation grace and ignores later callbacks', async () => {
    const shell = mockWindowsShell();
    const controller = new AbortController();
    const result = execute('echo recovery', controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    shell.close(new Error('killed'), 'callback stdout', 'callback stderr');
    const value = await result;
    expect(value).toMatchObject({ isError: true });
    expect(value.output).toContain('Command cancelled.');
    expect(value.output).toContain('callback stdoutcallback stderr');
    shell.close(null, 'late success');
    await vi.advanceTimersByTimeAsync(125_000);
    expect(await result).toBe(value);
    expect(vi.getTimerCount()).toBe(0);
    expect(shell.spawn).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(nativePlatform !== 'win32')('real Windows noninteractive shell', () => {
  it('executes date /t without waiting for stdin', async () => {
    const result = await execute('date /t');
    expect(result.isError).not.toBe(true);
    expect(result.output.trim()).not.toBe('');
    expect(result.output).not.toBe('(no output)');
    expect(result.output).toMatch(/\d/);
  }, 15_000);

  it('delivers EOF to a Node command that waits for stdin to end', async () => {
    const result = await execute(`node -e "process.stdin.resume(); process.stdin.on('end', () => { console.log('stdin EOF'); console.error('stderr EOF'); });"`);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('stdin EOF');
    expect(result.output).toContain('[stderr]\nstderr EOF');
  }, 15_000);
});
