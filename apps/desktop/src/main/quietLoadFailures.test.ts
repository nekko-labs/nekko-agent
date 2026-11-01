import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The filter wraps whatever process.emitWarning is when it installs.
const original = process.emitWarning;
const printed = vi.fn();
process.emitWarning = printed as unknown as typeof process.emitWarning;
const { quietLoadFailures } = await import('./quietLoadFailures.js');
afterAll(() => { process.emitWarning = original; });

const URL = 'http://127.0.0.1:14675/shot.png';
const warn = (url: string) => process.emitWarning(`Failed to load URL: ${url} with error: ERR_CONNECTION_REFUSED`, 'electron');

/** Electron's order for a failed navigation: provisional event, warning, did-fail-load. */
function failLoad(contents: EventEmitter, url: string, code = -102) {
  contents.emit('did-fail-provisional-load', {}, code, 'ERR', url);
  if (code !== -3) { warn(url); contents.emit('did-fail-load', {}, code, 'ERR', url); }
}

describe('quietLoadFailures', () => {
  const quiet = new EventEmitter();
  const loud = new EventEmitter();
  quietLoadFailures(quiet as unknown as WebContents);
  beforeEach(() => printed.mockClear());

  it("drops Electron's warning for a quieted window's failed load", () => {
    failLoad(quiet, URL);
    expect(printed).not.toHaveBeenCalled();
  });

  it("still prints other windows' failed loads and unrelated warnings", () => {
    failLoad(loud, URL);
    process.emitWarning('something else', 'electron');
    expect(printed).toHaveBeenCalledTimes(2);
  });

  it('does not stay armed after an aborted load, which Electron never warns about', () => {
    failLoad(quiet, URL, -3);
    failLoad(loud, URL);
    expect(printed).toHaveBeenCalledTimes(1);
  });
});
