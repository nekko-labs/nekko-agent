import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { WorkflowsView } from '../src/renderer/views/WorkflowsView';
import '../src/renderer/styles.css';

// Synthetic renderer only. No providers, connectors, host, or real user data.
const calls: string[] = [];
const scene = new URLSearchParams(window.location.search).get('scene');
const workflow = { id: 'existing', name: 'Existing briefing', category: 'Research', enabled: false, createdAt: 1, updatedAt: 1, steps: [], triggers: [] };

Object.assign(window, {
  nekko: {
    listWorkflows: async () => {
      if (scene === 'loading') return new Promise(() => {});
      if (scene === 'error') throw new Error('Synthetic load failure');
      return { workflows: scene === 'existing' ? [workflow] : [], runs: [] };
    },
    onWorkflowsUpdated: () => () => {},
    listWorkflowSkillDefs: async () => [],
    listModels: async () => [],
    createWorkflow: async () => { calls.push('create'); return null; },
    runWorkflow: async () => { calls.push('run'); return null; },
  },
  workflowEvidence: { calls },
});
useStore.setState({ settings: { providers: [], workspaces: [], connectors: [], theme: 'dark' } as any, installedSkillDefs: [] });
createRoot(document.getElementById('root')!).render(<WorkflowsView />);
