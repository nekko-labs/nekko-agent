import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRotatingLog, teeConsole } from './appLog.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nekko-applog-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('app log', () => {
  it('appends lines and creates the folder', async () => {
    const dir = join(temp(), 'logs');
    const log = createRotatingLog(dir);
    log.write('one');
    log.write('two\n');
    await log.flush();
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('one\ntwo\n');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'app.log')).mode & 0o777).toBe(0o600);
  });

  it('rotates past the cap and keeps a few old files', async () => {
    const dir = temp();
    const log = createRotatingLog(dir, 'app.log', { max: 10, keep: 2 });
    for (const line of ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']) {
      log.write(line);
      await log.flush();
    }
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('dddddd\n');
    expect(readFileSync(join(dir, 'app.log.1'), 'utf8')).toBe('cccccc\n');
    expect(readFileSync(join(dir, 'app.log.2'), 'utf8')).toBe('bbbbbb\n');
    expect(existsSync(join(dir, 'app.log.3'))).toBe(false);
  });

  it('continues the size of a file left by an earlier run', async () => {
    const dir = temp();
    const first = createRotatingLog(dir, 'app.log', { max: 10, keep: 1 });
    first.write('12345678');
    await first.flush();
    const second = createRotatingLog(dir, 'app.log', { max: 10, keep: 1 });
    second.write('abc');
    await second.flush();
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('abc\n');
    expect(readFileSync(join(dir, 'app.log.1'), 'utf8')).toBe('12345678\n');
  });

  it('tees the console with a time and level, and can be undone', async () => {
    const dir = temp();
    const log = createRotatingLog(dir);
    const printed: string[] = [];
    const target = {
      log: (...a: unknown[]) => printed.push(`log ${a.join(' ')}`),
      info: (...a: unknown[]) => printed.push(`info ${a.join(' ')}`),
      warn: (...a: unknown[]) => printed.push(`warn ${a.join(' ')}`),
      error: (...a: unknown[]) => printed.push(`error ${a.join(' ')}`),
      debug: (...a: unknown[]) => printed.push(`debug ${a.join(' ')}`),
    };
    const stop = teeConsole(log, target as unknown as Console, () => new Date('2026-10-20T10:00:00.000Z'));
    target.log('engine: %s', 'ready');
    target.error('two\nlines');
    stop();
    target.warn('after');
    await log.flush();
    expect(printed).toEqual(['log engine: %s ready', 'error two\nlines', 'warn after']);
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe(
      '2026-10-20T10:00:00.000Z LOG engine: ready\n2026-10-20T10:00:00.000Z ERROR two\n2026-10-20T10:00:00.000Z ERROR lines\n',
    );
  });

  it('drops writes it cannot make without throwing', async () => {
    const failing = { appendFile: () => Promise.reject(new Error('disk full')), rename: async () => {}, rm: async () => {}, size: async () => 0, mkdir: async () => {} };
    const log = createRotatingLog('/nowhere', 'app.log', { fs: failing });
    log.write('x');
    await expect(log.flush()).resolves.toBeUndefined();
  });
});
