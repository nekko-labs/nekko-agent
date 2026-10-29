import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMarketSkill, marketToSkillDef, SKILLS, summarizeSession, type Session } from '@nekko-agent/shared';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore } = await import('./store.js');

const existing: Session = { id: 'chat_1', title: 'Chat', createdAt: 1, updatedAt: 1, messages: [], providerId: 'p', modelId: 'm' };
const created: Session = { ...existing, id: 'chat_new' };
const skill = marketToSkillDef(getMarketSkill('nekko-agent-changelog')!);

beforeEach(() => {
  window.nekko = {
    createSession: vi.fn().mockResolvedValue(created),
    listSessions: vi.fn().mockResolvedValue([]),
  } as unknown as typeof window.nekko;
  useStore.setState({
    sessions: [],
    activeSessionId: null,
    activeProjectId: null,
    activeSkillBySession: {},
    draftBySession: {},
    composerInbox: null,
    view: 'skills',
  });
});

describe('Use in chat attaches a skill chip', () => {
  it('arms the skill on the active chat and keeps its draft', async () => {
    useStore.setState({ sessions: [summarizeSession(existing)], activeSessionId: existing.id, draftBySession: { [existing.id]: 'half-typed idea' } });
    const open = vi.spyOn(useStore.getState(), 'openChatPane').mockImplementation(() => {});
    try {
      await useStore.getState().attachSkillToChat(skill);
      expect(useStore.getState().activeSkillBySession[existing.id]).toBe(skill);
      // No text routed to the composer: the draft stays exactly as typed.
      expect(useStore.getState().composerInbox).toBeNull();
      expect(useStore.getState().draftBySession[existing.id]).toBe('half-typed idea');
      expect(useStore.getState().view).toBe('command');
      expect(open).toHaveBeenCalledWith(existing.id);
      expect(window.nekko.createSession).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });

  it('opens a new chat first when there is no usable one', async () => {
    const open = vi.spyOn(useStore.getState(), 'openChatPane').mockImplementation(() => {});
    const refresh = vi.spyOn(useStore.getState(), 'refreshSessions').mockResolvedValue(undefined);
    try {
      await useStore.getState().attachSkillToChat(skill);
      expect(window.nekko.createSession).toHaveBeenCalled();
      expect(useStore.getState().activeSessionId).toBe(created.id);
      expect(useStore.getState().activeSkillBySession[created.id]).toBe(skill);
      expect(useStore.getState().composerInbox).toBeNull();
    } finally { open.mockRestore(); refresh.mockRestore(); }
  });

  it('routes the goal skill as /goal text, since it has no chip', async () => {
    useStore.setState({ sessions: [summarizeSession(existing)], activeSessionId: existing.id });
    const goal = SKILLS.find((s) => s.kind === 'goal')!;
    const open = vi.spyOn(useStore.getState(), 'openChatPane').mockImplementation(() => {});
    try {
      await useStore.getState().attachSkillToChat(goal);
      expect(useStore.getState().activeSkillBySession[existing.id]).toBeUndefined();
      expect(useStore.getState().composerInbox).toEqual({ sessionId: existing.id, text: goal.template, run: false });
    } finally { open.mockRestore(); }
  });
});
