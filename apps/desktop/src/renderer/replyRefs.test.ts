import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@nekko-agent/shared';
import { issueRefUrl, onlyRepo, parseFileRef, resolveFileRef, touchedFiles } from './replyRefs.js';

const refs = { repo: { owner: 'nekko-labs', repo: 'nekko-agent' }, files: ['/repo/apps/ios/App/Views/RootView.swift', '/elsewhere/RootView.swift', '/repo/apps/ios/App/Theme.swift'] };

describe('reply references', () => {
  it('splits a code reference into its file and lines', () => {
    expect(parseFileRef('RootView.swift:164-166')).toEqual({ file: 'RootView.swift', line: '164-166' });
    expect(parseFileRef('src/App.tsx:12')).toEqual({ file: 'src/App.tsx', line: '12' });
    expect(parseFileRef('crates/nekko-workspace/src/git.rs')).toEqual({ file: 'crates/nekko-workspace/src/git.rs' });
    for (const text of ['npm run build', 'RootView', 'a.swift.bak', 'https://x.dev/a.ts', 'App.tsx:', 'foo.exe']) expect(parseFileRef(text)).toBeNull();
  });
  it('places a bare name on a file the agent touched, inside the chat folder first', () => {
    expect(resolveFileRef('RootView.swift', refs, '/repo')).toBe('/repo/apps/ios/App/Views/RootView.swift');
    expect(resolveFileRef('Views/RootView.swift', refs, '/elsewhere')).toBe('/repo/apps/ios/App/Views/RootView.swift');
    expect(resolveFileRef('RootView.swift', refs, '/elsewhere')).toBe('/elsewhere/RootView.swift');
  });
  it('never guesses where a bare untouched name is, but trusts a path with a folder', () => {
    expect(resolveFileRef('Other.swift', refs, '/repo')).toBeNull();
    expect(resolveFileRef('src/Other.swift', refs, '/repo')).toBe('/repo/src/Other.swift');
    expect(resolveFileRef('src/Other.swift', refs)).toBeNull();
    expect(resolveFileRef('strip.html', refs, '/repo', true)).toBe('/repo/strip.html');
    expect(resolveFileRef('/abs/x.rs', refs)).toBe('/abs/x.rs');
  });
  it('collects absolute file paths from tool calls, newest first', () => {
    const messages = [
      { id: '1', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 'a', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
      { id: '2', role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'b', name: 'Grep', input: { path: '/repo/src', pattern: 'x' } }, { id: 'c', name: 'Edit', input: { file_path: '/repo/b.ts' } }, { id: 'd', name: 'Read', input: { file_path: 'relative.ts' } }] },
    ] as ChatMessage[];
    expect(touchedFiles(messages)).toEqual(['/repo/b.ts', '/repo/a.ts']);
  });
  it('builds a PR or issue URL only with a repo', () => {
    expect(issueRefUrl('2480', undefined, false, refs)).toBe('https://github.com/nekko-labs/nekko-agent/pull/2480');
    expect(issueRefUrl('12', undefined, true, refs)).toBe('https://github.com/nekko-labs/nekko-agent/issues/12');
    expect(issueRefUrl('5', 'me/app', false, { files: [] })).toBe('https://github.com/me/app/pull/5');
    expect(issueRefUrl('2480', undefined, false, { files: [] })).toBeNull();
    expect(issueRefUrl('0', undefined, false, refs)).toBeNull();
  });
  it('falls back to the one repo every PR of the chat is in', () => {
    expect(onlyRepo([{ owner: 'a', repo: 'b' }, { owner: 'A', repo: 'B' }])).toEqual({ owner: 'a', repo: 'b' });
    expect(onlyRepo([{ owner: 'a', repo: 'b' }, { owner: 'a', repo: 'c' }])).toBeUndefined();
    expect(onlyRepo([])).toBeUndefined();
  });
});
