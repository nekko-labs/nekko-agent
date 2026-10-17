import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newAgentSetup } from './newAgentSetup.js';

describe('new agent setup calls', () => {
  it('opens a plain new agent without extra host round trips', () => {
    expect(newAgentSetup({}, { chatType: 'multimodal' })).toEqual({ options: false, supporting: false });
    // Toolbar New agent with saved default folders: one folder, nothing to support.
    expect(newAgentSetup({}, { chatType: 'multimodal', workspaceIds: ['w1'] })).toEqual({ options: false, supporting: false });
  });

  it('still configures what the picker changed', () => {
    expect(newAgentSetup({}, { chatType: 'image' }).options).toBe(true);
    expect(newAgentSetup({}, { providerId: 'p' }).options).toBe(true);
    expect(newAgentSetup({}, { modelId: 'm' }).options).toBe(true);
    expect(newAgentSetup({}, { workspaceIds: ['w1', 'w2'] }).supporting).toBe(true);
    // A reused session that already has supporting folders is cleared to the new choice.
    expect(newAgentSetup({ supportingWorkspaceIds: ['old'] }, { workspaceIds: ['w1'] }).supporting).toBe(true);
    // A reused image session asked to be a chat again.
    expect(newAgentSetup({ chatType: 'image' }, { chatType: 'multimodal' }).options).toBe(true);
  });

  it('seeds the cache so the new window paints the created chat on its first frame', () => {
    const source = readFileSync(new URL('./views/CommandCenterView.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/putCachedSession\(s\);\s*addCreatedSession\(s\);/);
  });

  it('lets the wall window reveal be the only entrance animation', () => {
    const source = readFileSync(new URL('./components/ChatPane.tsx', import.meta.url), 'utf8');
    expect(source).toContain("className={`${commandCenter ? '' : 'fade-in '}mt-16 flex flex-col items-center gap-3 text-center`} data-chat-welcome");
  });
});
