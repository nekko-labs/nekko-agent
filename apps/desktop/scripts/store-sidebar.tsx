import { useStore } from '../src/renderer/store';
import { AgentSidebar } from '../src/renderer/views/WorkspacesView';

/** The Agents list wired straight to the store, for fixtures that show it without the wall. */
export function StoreSidebar() {
  const s = useStore.getState();
  return (
    <AgentSidebar
      selectedId={null}
      onOpenChat={(id) => s.openChatPane(id)}
      onOpenTerminal={(id) => s.openTerminalPane(id)}
      onCreate={async (kind, projectId, shell) => {
        if (kind === 'terminal') await s.newTerminalWorkspace(projectId, shell);
        else if (kind === 'image') await s.newImageChat('');
        else await s.newChat(projectId);
      }}
    />
  );
}
