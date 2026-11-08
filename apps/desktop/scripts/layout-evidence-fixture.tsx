// Synthetic full-App fixture for layout evidence. Sets up the desktop chrome
// bridge (macOS) before any renderer module loads; never contacts a host.
// Two screens, the main window on the first, so the Dynamic toolbar shows its Screens control.
const screensState = { placement: 'empty-first', displays: [1, 2].map((n) => ({ id: String(n), label: String(n), bounds: { x: (n - 1) * 1728, y: 0, width: 1728, height: 1117 }, main: n === 1, primary: n === 1, enabled: n === 1, self: n === 1, scaleFactor: 2 })) };
// Sandboxes swap the screens (e.g. one screen with three desktops) through `screensFixture`.
const screensFixture: any = { state: screensState, emit: (_: unknown) => {} };
(window as any).screensFixture = screensFixture;
const current = async () => screensFixture.state;
const displays = { displayId: localStorage.getItem('fixture.displayId'), list: current, toggle: current, setPlacement: current, toggleDesktop: current, setSpacesMode: current, go: async () => 'ok', report: () => {}, claim: async () => 'main', onChange: (cb: (s: unknown) => void) => { screensFixture.emit = cb; return () => {}; }, onPlaced: () => () => {} };
// A sandbox can open the App as a second screen's window (localStorage 'fixture.displayId') before a reload.
// A sandbox can pick Windows chrome (localStorage 'fixture.platform') before a reload.
(window as any).nekkoChrome = { platform: localStorage.getItem('fixture.platform') ?? 'darwin', titleBarHeight: 38, setTitleBarOverlay: () => {}, ...((window as any).nekkoTestZoom ? { setPageZoom: (window as any).nekkoTestZoom } : {}), serviceControl: async () => ({}), reportNotificationVisibility: () => {}, displays };
const now = Date.now();
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'ChatGPT (subscription)', auth: 'subscription', tokenKey: 'fixture' };
const session = (id: string, title: string, workspaceId?: string) => ({ id, title, createdAt: now, updatedAt: now - 3600e3, providerId: 'fixture', modelId: 'gpt-fixture', mode: 'agent', chatType: 'multimodal', workspaceId, messages: [], attachments: [], queuedPrompts: [] });
const records = [session('a', 'Persist quota history'), session('b', 'Diagnose failed build'), session('c', 'Audit sandbox policy'), session('d', 'New chat')];
const settings = { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: { onboarded: true }, onboarded: true, firstPromptIntroSeen: true, showTips: false, commandWall: { zonesIntro: true } };
const agentListeners = new Set<(event: any) => void>();
const emitAgent = (event: any) => { for (const listener of agentListeners) listener(event); };
const bridge: any = {
  onAgentEvent: (listener: (event: any) => void) => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
  sendChat: async (opts: any) => { (window as any).layoutFixture.lastSend = opts; },
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'darwin' }),
  getSettings: async () => settings, updateSettings: async (p: any) => ({ ...Object.assign(settings, p) }), listProviders: async () => [provider],
  listSessionSummaries: async () => [],
  // CiRunnersView mounts with the App: its list contract is an array, not null.
  listRunners: async (): Promise<import('@nekko-agent/shared').RunnerView[]> => [],
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }],
  createSession: async () => { const s = session('n' + records.length, 'New chat'); records.push(s); return s; },
  listTerminals: async () => [], listRunners: async () => [],
  listSkillSources: async () => [], skillTargets: async () => [],
  listConnectors: async () => [], getMessagingStatus: async () => ({}),
  // A sandbox can seed agent states (localStorage 'fixture.pending' / 'fixture.running') before a reload.
  pendingInput: async () => JSON.parse(localStorage.getItem('fixture.pending') ?? '{}'), runningSessions: async () => JSON.parse(localStorage.getItem('fixture.running') ?? '[]'), listTasks: async () => [],
  listInstalledSkills: async () => [], listExternalSkills: async () => [], listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [], getUsageSummary: async () => null,
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(t, k: string) { if (k in t) return t[k]; if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
import('@nekko-agent/shared').then(async ({ summarizeSession }) => {
  // A sandbox can seed what the engine would add to a summary (localStorage 'fixture.summaries', by chat id).
  bridge.listSessionSummaries = async () => {
    const seeded = JSON.parse(localStorage.getItem('fixture.summaries') ?? '{}');
    return records.map(summarizeSession).map((s) => ({ ...s, ...seeded[s.id] }));
  };
  const [{ createRoot }, React, { App }, { useStore }, { putCachedSession }, { UpdateProvider }] = await Promise.all([import('react-dom/client'), import('react'), import('../src/renderer/App'), import('../src/renderer/store'), import('../src/renderer/sessionCache'), import('../src/renderer/components/UpdateBanner')]);
  await import('@fontsource-variable/inter-tight');
  await import('@fontsource-variable/jetbrains-mono');
  await import('../src/renderer/styles.css');
  records.forEach(putCachedSession);
  document.documentElement.dataset.theme = 'dark';
  const root = createRoot(document.getElementById('root')!);
  root.render(React.createElement(UpdateProvider, null, React.createElement(App)));
  (window as any).layoutFixture = { store: useStore, records, bridge, settings, putCachedSession, emitAgent, showTheme: async () => {
    const { ThemeStep } = await import('../src/renderer/components/onboarding/ThemeStep');
    root.render(React.createElement('main', { style: { padding: 24, minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)' } },
      React.createElement('div', { style: { maxWidth: 640, margin: 'auto' } }, React.createElement(ThemeStep))));
  }, showRetry: async () => {
    const { ChatPane } = await import('../src/renderer/components/ChatPane');
    const record = records[0] as any;
    record.messages = [
      { id: 'u0', role: 'user', content: 'Earlier question', createdAt: now - 6000 },
      { id: 'a0', role: 'assistant', content: 'Earlier answer remains saved.', createdAt: now - 5000 },
      { id: 'u1', role: 'user', content: 'Continue the implementation', createdAt: now - 4000 },
      { id: 'a1', role: 'assistant', content: 'Completed the first step before interruption.', createdAt: now - 3000 },
      { id: 'interrupted', role: 'assistant', content: '_This reply was cut off before it finished. Everything above is kept, resume to carry on from here._', interrupted: true, createdAt: now - 2000 },
    ];
    putCachedSession(record);
    useStore.setState({ providers: [provider], models: [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }], settings, activeSessionId: 'a' } as any);
    root.render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(ChatPane, { sessionId: 'a' })));
    const { applyEvent } = await import('../src/renderer/liveRuns');
    (window as any).layoutFixture.emit = (event: any) => { applyEvent({ ...event, sessionId: 'a' }); emitAgent({ ...event, sessionId: 'a' }); };
  }, showProviderCleanup: async () => {
    const { ModelsView } = await import('../src/renderer/views/ModelsView');
    const providers: any[] = [
      { id: 'claude', kind: 'claude-code', label: 'Claude subscription', enabled: true, claudeCode: {} },
      { id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT (subscription)', enabled: true, auth: 'subscription', tokenKey: 'fixture', accountId: 'fixture-account', baseUrl: 'https://chatgpt.com/backend-api' },
    ];
    bridge.listProviders = async () => providers;
    bridge.testProvider = async () => ({ ok: true });
    bridge.listModelsStatus = async (id: string) => ({ models: [{ id: id === 'claude' ? 'sonnet' : 'gpt-fixture', name: id === 'claude' ? 'Claude Sonnet' : 'GPT fixture', providerId: id }] });
    bridge.getClaudeCodeStatus = async () => ({ installed: true, version: '2.1.319', loggedIn: true, email: 'person@example.test', subscriptionType: 'pro', orgName: 'Personal' });
    bridge.oauthStatus = async () => ({ provider: 'chatgpt', connected: true, state: 'connected', expiresAt: Date.now() + 9 * 86400e3 });
    bridge.getLimits = async (key: string) => ({ updatedAt: now, staleAfterMs: 300000, planType: 'pro', windows: [{ id: 'weekly', label: '7-day', scope: 'weekly', usedPercent: 41, resetAt: Date.now() + 5 * 86400e3, status: 'allowed' }] });
    useStore.setState({ providers, activeModelId: 'gpt-fixture' } as any);
    root.render(React.createElement('main', { style: { padding: 24, height: '100vh', overflow: 'auto', background: 'var(--paper)' } }, React.createElement('h2', { className: 'models-section-heading', style: { marginBottom: 24 } }, 'Cloud providers'), React.createElement(ModelsView, { key: performance.now() })));
  }, showProviderSetupCleanup: async (surface: 'add' | 'onboarding' | 'choices') => {
    const { AddProvider } = await import('../src/renderer/components/providers/AddProvider');
    const { ProvidersStep } = await import('../src/renderer/components/onboarding/ProvidersStep');
    const { ProviderChoices } = await import('../src/renderer/components/providers/ProviderChoices');
    useStore.setState({providers: []});
    bridge.listProviders = async () => [];
    bridge.oauthStatus = async () => ({provider:'chatgpt', connected:false, state:'idle'});
    bridge.probeProviders = async () => [];
    const noop = () => {};
    const content = surface === 'onboarding' ? React.createElement(ProvidersStep, {key: performance.now()}) : surface === 'choices' ? React.createElement(ProviderChoices, {onPick:noop, current:'gemini', cloudOnly:true}) : React.createElement(AddProvider, {onDone:noop, fixedKind:'chatgpt'});
    root.render(React.createElement('main', {style: {padding:24, height:'100vh', overflow:'auto', background:'var(--paper)'}}, content));
  }, showFolderComposer: async (cleanStart = false, expert = true, surface: 'full' | 'window' | 'composer' = 'window') => {
    const { ChatPane } = await import('../src/renderer/components/ChatPane');
    localStorage.setItem('nekko.chatMode', expert ? 'expert' : 'simple');
    const { saveDraft } = await import('../src/renderer/composerDrafts');
    const record = { ...records[0], id: `folders-${cleanStart}-${expert}-${surface}` } as any;
    records[0] = record;
    saveDraft(record.id, { text: 'Please help improve the project layout and check the changes.', images: [] });
    record.mode = 'ask';
    record.workspaceId = 'code';
    record.supportingWorkspaceIds = [];
    record.messages = cleanStart ? [] : [{ id: 'u', role: 'user', content: 'Check the project layout.', createdAt: now }, { id: 'r', role: 'assistant', content: 'Ready to work in the selected folder.', createdAt: now }];
    const folders = [{ id: 'code', name: 'code', path: 'C:/fixture/code' }, { id: 'docs', name: 'docs', path: 'C:/fixture/docs' }];
    Object.assign(settings, { workspaces: folders, themePreset: 'x-plum-dark' });
    bridge.setSessionWorkspace = async (_id: string, workspaceId: string) => { record.workspaceId = workspaceId; return { ...record }; };
    bridge.setSessionSupportingWorkspaces = async (_id: string, ids: string[]) => { record.supportingWorkspaceIds = ids; return { ...record }; };
    bridge.setSessionOptions = async (_id: string, patch: any) => { Object.assign(record, patch); return { ...record }; };
    putCachedSession(record);
    useStore.setState({ providers: [provider], models: [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }], sessions: records.map(summarizeSession), settings: { ...settings }, activeSessionId: record.id, running: new Set() } as any);
    root.render(React.createElement('div', { className: surface === 'window' ? 'wall-composer' : undefined, style: { height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 16 } }, React.createElement(ChatPane, { key: `folders-${cleanStart}-${expert}-${surface}`, sessionId: record.id, cleanStart, surface: surface === 'composer' ? 'composer' : 'full', commandCenter: surface === 'window', header: surface === 'composer' ? React.createElement('span', null, 'Active chat') : undefined })));
  }, showComposer: async (surface: 'full' | 'composer' | 'window' = 'composer', cleanStart = false) => {
    const { ChatPane } = await import('../src/renderer/components/ChatPane');
    useStore.setState({ providers: [provider], models: [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }], settings, activeSessionId: 'a', running: new Set(['a']) } as any);
    bridge.abortChat = async (id: string) => { (window as any).layoutFixture.lastAbort = id; };
    bridge.queuePrompt = async (id: string, prompt: any) => { (window as any).layoutFixture.lastQueue = { sessionId: id, prompt }; return records.find(s => s.id === id); };
    root.render(React.createElement('div', { className: surface === 'window' ? 'wall-composer' : undefined, style: { height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 24 } }, React.createElement(ChatPane, { key: surface, sessionId: 'a', cleanStart, surface: surface === 'window' ? 'full' : surface, commandCenter: surface === 'window', header: surface === 'composer' ? React.createElement('span', null, 'Persist quota history') : undefined })));
  }, showPrLifecycle: async (stream = false) => {
    const { ChatPane } = await import('../src/renderer/components/ChatPane');
    const { applyEvent } = await import('../src/renderer/liveRuns');
    const url = 'https://github.com/example/project/pull/42';
    const record = records[0] as any;
    const startedAt = now - 10000;
    const pr = { url, owner: 'example', repo: 'project', number: 42, title: 'Keep pull requests visible in chat', state: stream ? 'open' : 'merged', isDraft: false, additions: 12, deletions: 3, changedFiles: 2, checks: 'passing', source: 'gh', mergedAt: new Date(startedAt + 5000).toISOString() };
    record.messages = [{ id: 'prompt', role: 'user', content: 'Ship this change.', createdAt: startedAt }];
    const steps = [
      { id: 'create', command: 'gh pr create --draft --fill', output: url },
      { id: 'draft', command: 'gh pr ready 42 --undo --repo example/project', output: '✓ Pull request example/project#42 is converted to "draft"' },
      { id: 'ready', command: 'gh pr ready 42 --repo example/project', output: '✓ Pull request example/project#42 is marked as "ready for review"' },
      { id: 'auto', command: 'gh pr merge 42 --auto --repo example/project', output: '✓ Pull request example/project#42 will be automatically merged via squash when all requirements are met' },
      { id: 'queue', command: 'gh pr merge 42 --auto --repo example/project', output: '✓ Added pull request example/project#42 to the merge queue' },
      { id: 'merge', command: 'gh pr merge 42 --repo example/project', output: '✓ Merged pull request example/project#42' },
    ];
    let tick = startedAt;
    const emit = (step: typeof steps[number]) => {
      const call = { id: step.id, name: 'bash', input: { command: step.command } };
      const result = { toolCallId: step.id, output: step.output };
      record.messages.push({ id: `call_${step.id}`, role: 'assistant', content: '', createdAt: ++tick, toolCalls: [call] });
      record.messages.push({ id: `result_${step.id}`, role: 'tool', content: step.output, createdAt: ++tick, toolResult: result });
      if (stream) {
        const events = [{ type: 'tool_call', call }, { type: 'tool_result', result }];
        for (const event of events) { applyEvent({ ...event, sessionId: 'a' } as any); emitAgent({ ...event, sessionId: 'a' }); }
      }
    };
    if (!stream) { steps.forEach(emit); record.messages.push({ id: 'answer', role: 'assistant', content: 'Merged. The change is now on main.', createdAt: startedAt + 6000 }); }
    bridge.listSessionPrs = async () => [pr];
    bridge.openPath = async (href: string) => { (window as any).layoutFixture.lifecycle.openedUrl = href; };
    bridge.getContextBundle = async () => ({ items: [], totalTokens: 0, budget: 128000 });
    putCachedSession(record);
    useStore.setState({ providers: [provider], models: [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }], sessions: records.map(summarizeSession), settings, activeSessionId: 'a', prsBySession: { a: [pr] }, running: new Set() } as any);
    root.render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(ChatPane, { key: `pr-${stream}`, sessionId: 'a' })));
    (window as any).layoutFixture.lifecycle = { steps, emit: (index: number) => emit(steps[index]), finish: () => {
      record.messages.push({ id: 'answer', role: 'assistant', content: 'Queued; waiting for required checks.', createdAt: ++tick });
      applyEvent({ type: 'done', sessionId: 'a', messageId: 'answer' });
      emitAgent({ type: 'done', sessionId: 'a', messageId: 'answer' });
    } };
  }, showVisibility: async () => {
    // #1666: a long answer under a plan, with a thought and a tool step before it.
    const { ChatPane } = await import('../src/renderer/components/ChatPane');
    const record = records[0] as any;
    record.messages = [
      { id: 'prompt', role: 'user', content: 'Review the changes and verify the interface.', createdAt: now - 5000 },
      { id: 'work', role: 'assistant', content: '', reasoning: 'Check the project guidance before editing.', toolCalls: [{ id: 'read', name: 'read_file', input: { path: 'README.md' } }], createdAt: now - 4000 },
      { id: 'result', role: 'tool', content: 'Project guidance', toolResult: { toolCallId: 'read', output: 'Project guidance' }, createdAt: now - 3000 },
      { id: 'answer', role: 'assistant', content: Array.from({ length: 30 }, (_, i) => `### Review section ${i + 1}\n\nEach section of the review is long enough to fill the pane, so the transcript has to scroll behind the floating plan and the cat to reach its last row.`).join('\n\n'), createdAt: now - 2000 },
    ];
    record.agentPlan = ['Inspect the interface', 'Make the changes', 'Verify scrolling', 'Publish the result'].map((title, i) => ({ id: String(i), title, kind: ['build', 'build', 'verify', 'ship'][i], status: i < 2 ? 'done' : i === 2 ? 'active' : 'pending', createdAt: now, updatedAt: now }));
    putCachedSession(record);
    useStore.setState({ providers: [provider], models: [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }], sessions: records.map(summarizeSession), settings, activeSessionId: 'a', running: new Set() } as any);
    root.render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(ChatPane, { key: 'visibility', sessionId: 'a' })));
  }, showGreeting: async () => {

    const { ChatPane } = await import('../src/renderer/components/ChatPane');
    useStore.setState({ providers: [provider], models: [{ id: 'gpt-fixture', providerId: 'fixture', name: 'GPT fixture', contextWindow: 500000 }], settings, activeSessionId: 'd' } as any);
    root.render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(ChatPane, { sessionId: 'd', cleanStart: true })));
  }, showSkeletons: async () => {
    const { PixelSkeleton } = await import('../src/renderer/components/PixelSkeleton');
    const cards = [
      { label: 'Wide card', style: { width: 480, height: 180 } },
      { label: 'Square card', style: { width: 180, height: 180 } },
      { label: 'Row card', style: { width: 480, height: 60 } },
      { label: 'Tall card', style: { width: 240, height: 320 } },
    ];
    root.render(React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 24, padding: 32, background: 'var(--paper)', minHeight: '100vh', color: 'var(--ink)' } },
      cards.map(({ label, style }) => React.createElement('div', { key: label, style: { display: 'grid', gap: 8 } },
        React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, label),
        React.createElement(PixelSkeleton, { style: { ...style, borderRadius: 12 }, label })))));
  }, showPlusMenu: async () => {
    const { CreateMenuRows } = await import('../src/renderer/components/CreateMenu');
    // On the base branch CreateMenuRows read `terminal` to gate the Terminal row (Simple mode hid it);
    // on this branch there is no such prop and all three rows always show. Passing `terminal: false` to
    // whichever version loads keeps the comparison honest.
    root.render(React.createElement('div', { style: { padding: 32, background: 'var(--paper)', minHeight: '100vh', color: 'var(--ink)' } },
      React.createElement('div', { className: 'create-menu card p-1 shadow-(--shadow-float)', style: { width: 'max-content' } },
        React.createElement(CreateMenuRows as any, { onCreate: () => {}, terminal: false }))));
  } };
});
