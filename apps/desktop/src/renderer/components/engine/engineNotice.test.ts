import { describe, expect, it } from 'vitest';
import type { LocalModel } from '@nekko-agent/shared';
import { engineNotice, engineUpdateText, modelsNeedingNewerEngine } from './engineNotice.js';

const problem = { message: 'Missing its GPU libraries.', repairBuildId: 'win-x64-cuda' };
const upgrade = { buildId: 'win-x64-cuda', message: 'CUDA is faster.' };
const outdated = {
  buildId: 'win-x64-cuda',
  installed: 'b11224',
  pinned: 'b12436',
  message: 'Your engine is b11224; this version of Nekko Agent expects b12436.',
  notify: true,
};
// A few days behind: the normal state, since the pin moves several times a day.
const slightlyOld = { ...outdated, installed: 'b12400', message: 'Your engine is b12400; this version of Nekko Agent expects b12436.', notify: false };

describe('engineNotice', () => {
  it('says nothing about a current engine', () => {
    expect(engineNotice({})).toBeNull();
  });

  it('offers the update alone when the engine is far behind', () => {
    expect(engineNotice({ outdated })).toBe('update');
  });

  it('says nothing about an engine that is only slightly old, unless a file needs a newer one', () => {
    expect(engineNotice({ outdated: slightlyOld })).toBeNull();
    expect(engineNotice({ outdated: slightlyOld }, 0)).toBeNull();
    expect(engineNotice({ outdated: slightlyOld }, 2)).toBe('update');
    // Nothing to install without the outdated build, whatever the library says.
    expect(engineNotice({}, 2)).toBeNull();
  });

  it('keeps repair and the CUDA switch first however the update came about', () => {
    expect(engineNotice({ problem, outdated: slightlyOld }, 2)).toBe('repair');
    expect(engineNotice({ upgrade, outdated: slightlyOld }, 2)).toBe('switch');
    expect(engineNotice({ upgrade, outdated: slightlyOld })).toBe('switch');
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

describe('engineUpdateText', () => {
  it('names the models that need it, and falls back to the engine message when far behind', () => {
    expect(engineUpdateText(slightlyOld, 1)).toBe('1 model in your library needs a newer engine.');
    expect(engineUpdateText(slightlyOld, 2)).toBe('2 models in your library need a newer engine.');
    expect(engineUpdateText(outdated, 0)).toBe(outdated.message);
    // Both apply: the files are the reason that matters to the person.
    expect(engineUpdateText(outdated, 3)).toBe('3 models in your library need a newer engine.');
  });
});

describe('modelsNeedingNewerEngine', () => {
  it('counts the models blocked only by the engine being too old', () => {
    const m = (loadCheck?: LocalModel['loadCheck']) => ({ id: 'x', name: 'x', path: '/x', loadCheck }) as LocalModel;
    const age = { level: 'blocked', cause: 'engineAge', reason: 'old' } as const;
    const format = { level: 'blocked', cause: 'weightFormat', reason: 'fork' } as const;
    const warn = { level: 'warning', cause: 'engineAge', reason: 'maybe' } as const;
    expect(modelsNeedingNewerEngine([m(age), m(format), m(warn), m(), m(age)])).toBe(2);
    expect(modelsNeedingNewerEngine([])).toBe(0);
  });
});
