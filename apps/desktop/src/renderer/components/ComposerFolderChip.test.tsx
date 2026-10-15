import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session, WorkspaceFolder } from '@agent-nekko/shared';
import { accessLabel, chatAccessItems, ComposerFolderChip } from './ComposerFolderChip.js';
import { SubagentsRunningChipView, subagentsRunningLabel } from './agent-console/SubagentsRunningChip.js';

const ws = (id: string, path: string): WorkspaceFolder => ({ id, name: id, path, addedAt: 0 });
const workspaces = [ws('a', 'C:\\code\\agent-nekko'), ws('b', '/home/me/docs'), ws('c', '/srv/other')];
const session = (over: Partial<Session>): Session => ({ id: 's', title: 't', messages: [], createdAt: 0, updatedAt: 0, ...over });

describe('composer folder access chip', () => {
  it('lists primary folder first, then supporting folders, then attached files', () => {
    const items = chatAccessItems(session({ workspaceId: 'b', supportingWorkspaceIds: ['a'], attachedPaths: ['/tmp/notes.md'] }), workspaces);
    expect(items.map((i) => [i.kind, i.name, !!i.primary])).toEqual([
      ['folder', 'docs', true],
      ['folder', 'agent-nekko', false],
      ['file', 'notes.md', false],
    ]);
  });

  it('names a single folder and counts several', () => {
    expect(accessLabel(chatAccessItems(session({ workspaceId: 'a' }), workspaces))).toBe('agent-nekko');
    expect(accessLabel(chatAccessItems(session({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }), workspaces))).toBe('3 folders');
    expect(accessLabel(chatAccessItems(session({ workspaceId: 'a', supportingWorkspaceIds: ['b'], attachedPaths: ['/x/y.ts'] }), workspaces))).toBe('2 folders · 1 file');
    expect(accessLabel([])).toBeNull();
  });

  it('renders nothing without access, and the folder icon with the label otherwise', () => {
    expect(renderToStaticMarkup(<ComposerFolderChip session={session({})} workspaces={workspaces} onSessionChange={() => {}} />)).toBe('');
    const html = renderToStaticMarkup(<ComposerFolderChip session={session({ workspaceId: 'a', supportingWorkspaceIds: ['b'] })} workspaces={workspaces} onSessionChange={() => {}} />);
    expect(html).toContain('Folder access: 2 folders');
    expect(html).toContain('<svg');
  });
});

describe('subagents running chip', () => {
  it('reads n subagents running and hides at zero', () => {
    expect(subagentsRunningLabel(0)).toBeNull();
    expect(subagentsRunningLabel(1)).toBe('1 subagent running');
    expect(subagentsRunningLabel(3)).toBe('3 subagents running');
    const html = renderToStaticMarkup(<SubagentsRunningChipView label="2 subagents running" />);
    expect(html).toMatch(/<svg[\s\S]*2 subagents running/);
  });
});
