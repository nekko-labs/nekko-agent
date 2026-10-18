import { describe, expect, it } from 'vitest';
import { phaseRecorder, untimed } from './agentBrowserTiming.js';

describe('phaseRecorder', () => {
  it('records each phase in completion order, including ones that throw', async () => {
    let clock = 0;
    const { mark, phases } = phaseRecorder(() => clock);
    expect(await mark('a', async () => { clock += 2.5; return 'value'; })).toBe('value');
    await expect(mark('b', async () => { clock += 1; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(phases).toEqual([{ phase: 'a', ms: 2.5 }, { phase: 'b', ms: 1 }]);
  });

  it('untimed only runs the work', async () => {
    expect(await untimed('x', async () => 7)).toBe(7);
  });
});
