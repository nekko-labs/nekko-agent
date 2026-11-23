import { describe, expect, it } from 'vitest';
import { engineNotice } from './engineNotice.js';

const problem = { message: 'Missing its GPU libraries.', repairBuildId: 'win-x64-cuda' };
const upgrade = { buildId: 'win-x64-cuda', message: 'CUDA is faster.' };
const outdated = {
  buildId: 'win-x64-cuda',
  installed: 'b11224',
  pinned: 'b12436',
  message: 'Your engine is b11224; this version of Nekko Agent expects b12436.',
};

describe('engineNotice', () => {
  it('says nothing about a current engine', () => {
    expect(engineNotice({})).toBeNull();
  });

  it('offers the update alone when the engine is only old', () => {
    expect(engineNotice({ outdated })).toBe('update');
  });

  it('shows one button when several would download the same release', () => {
    // A broken engine is repaired before anything else, old or not.
    expect(engineNotice({ problem, outdated })).toBe('repair');
    expect(engineNotice({ problem, upgrade, outdated })).toBe('repair');
    expect(engineNotice({ problem, upgrade })).toBe('repair');
    // The CUDA switch brings the pinned release too, so it stands in for the update.
    expect(engineNotice({ upgrade, outdated })).toBe('switch');
    expect(engineNotice({ upgrade })).toBe('switch');
  });
});
