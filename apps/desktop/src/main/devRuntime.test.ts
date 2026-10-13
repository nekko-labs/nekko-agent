import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: undefined }));
import { correctDevPackaging } from './devRuntime.js';

describe('correctDevPackaging', () => {
  it('reports the branded dev runtime as unpackaged', () => {
    const app = { isPackaged: true };
    correctDevPackaging(app, true);
    expect(app.isPackaged).toBe(false);
  });

  it('leaves an installed app packaged', () => {
    const app = { isPackaged: true };
    correctDevPackaging(app, undefined);
    expect(app.isPackaged).toBe(true);
  });
});
