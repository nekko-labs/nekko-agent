import { describe, expect, it } from 'vitest';
import { createCloseIntent, readWParam, SC_CLOSE } from './closeIntent.js';

describe('createCloseIntent', () => {
  it('treats a bare WM_CLOSE (taskkill without /F) as another program asking to quit', () => {
    const intent = createCloseIntent();
    intent.closeMessage();
    expect(intent.takeExternal()).toBe(true);
  });

  it('treats SC_CLOSE then WM_CLOSE (Alt+F4, taskbar Close window) as a person closing', () => {
    const intent = createCloseIntent();
    intent.sysCommand(SC_CLOSE | 0x2);
    intent.closeMessage();
    expect(intent.takeExternal()).toBe(false);
  });

  it('treats a close with no WM_CLOSE at all (the drawn caption button) as a person closing', () => {
    expect(createCloseIntent().takeExternal()).toBe(false);
  });

  it('ignores other system commands and resets after each close', () => {
    const intent = createCloseIntent();
    intent.sysCommand(0xf020); // SC_MINIMIZE
    intent.closeMessage();
    expect(intent.takeExternal()).toBe(true);
    expect(intent.takeExternal()).toBe(false);
    intent.sysCommand(SC_CLOSE);
    expect(intent.takeExternal()).toBe(false);
    intent.closeMessage();
    expect(intent.takeExternal()).toBe(true);
  });

  it('reads the pointer-sized wParam buffer', () => {
    const buf = Buffer.alloc(8); buf.writeUInt32LE(SC_CLOSE, 0);
    expect(readWParam(buf)).toBe(SC_CLOSE);
    expect(readWParam(Buffer.alloc(0))).toBe(0);
  });
});
