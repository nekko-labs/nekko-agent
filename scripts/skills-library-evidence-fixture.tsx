import React from 'react';
import { createRoot } from 'react-dom/client';
import { SkillsView } from '../apps/desktop/src/renderer/views/SkillsView';
import { useStore } from '../apps/desktop/src/renderer/store';
import { SKILLS } from '@nekko-agent/shared';
import '../apps/desktop/src/renderer/styles.css';

// The Skills view reads only the store; the bridge answers every call with nothing.
const w = window as unknown as { nekko: unknown };
w.nekko = new Proxy({}, { get: (_, k: string) => (k.startsWith('on') ? () => () => {} : () => Promise.resolve(null)) });

// One skill imported read-only from Claude Code, so the Imported group and origin chip render.
const research = SKILLS.find((s) => s.name === 'research')!;
useStore.setState({
  settings: {} as never,
  installedSkillDefs: [
    {
      ...research,
      id: 'ext-claude-changelog',
      name: 'changelog',
      description: 'Draft release notes from merged PRs since the last tag',
      category: 'Imported',
      highlighted: false,
      kind: 'prompt',
      origin: { tool: 'claude', scope: 'user', dir: '~/.claude/skills/changelog' },
    } as never,
  ],
});
createRoot(document.getElementById('root')!).render(
  <main className="bg-paper text-ink" style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <SkillsView />
  </main>,
);
