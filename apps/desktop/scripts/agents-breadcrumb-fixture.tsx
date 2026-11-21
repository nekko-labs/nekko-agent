// Extend the shared full-App fixture with read-only responses for every page.
import './layout-evidence-fixture';
const ready = setInterval(() => {
  const f = (window as any).layoutFixture;
  if (!f) return;
  clearInterval(ready);
  Object.assign(f.settings, { guardrails: [], experimental: {training:true,design:true,memory:true} });
  Object.assign(f.bridge, {
    listTrainingRuns: async () => [], listMemory: async () => [], engineModels: async () => [],
    listWorkflows: async () => ({ workflows: [], runs: [] }), listWorkflowSkillDefs: async () => [],
    listWorkflowTemplates: async () => [], telemetryStatus: async () => ({ configured: false }),
    getRemoteStatus: async () => ({ enabled: false, devices: [] }),
  });
  f.store.setState({ settings: {...f.settings} });
  (window as any).breadcrumbFixtureReady = true;
}, 10);
