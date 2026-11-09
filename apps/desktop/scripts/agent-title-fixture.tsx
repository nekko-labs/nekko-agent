// Real cards with synthetic data. No host, credentials or network requests.
(window as any).nekko = new Proxy({}, { get: (_, key) => String(key).startsWith('on') ? () => () => {} : async () => null });
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/WorkspaceCard'), import('../src/renderer/store'), import('../src/renderer/styles.css'), import('@fontsource-variable/geist')]).then(([React, { createRoot }, { WorkspaceCard }, { useStore }]) => {
  const now = 1800000000000;
  useStore.setState({ providers: [], models: [], prsBySession: {}, sessionCtxEstimate: {} });
  const records = [
    ['Consolidate macOS keychain storage', 'gpt-6.1-sol', 16 * 60],
    ['Restore summarized Claude agent titles', 'opus', 7],
    ['Keep agent timestamps right aligned', 'opus', 13],
    ['Nekko Agent View Menu', 'gpt-6-astra', 45],
  ];
  (window as any).titleFixture = { opened: 0, renamed: null, completed: 0 };
  function Card({ record, index }: any) {
    const [renaming, setRenaming] = React.useState(false);
    const [title, setTitle] = React.useState(record[0]);
    return <WorkspaceCard workspace={null} session={{ id: `s${index}`, title, modelId: record[1], lastReplyAt: now - record[2] * 60000, transcriptTokens: 108000 } as any} terminal={null} status="done" isActive={index === 2} now={now} projects={[]} renaming={renaming}
      onOpen={() => { (window as any).titleFixture.opened++; }} onClose={() => { (window as any).titleFixture.completed++; }}
      onRenameStart={() => setRenaming(true)} onRename={value => { if (value) setTitle(value); setRenaming(false); (window as any).titleFixture.renamed = value; }} />;
  }
  createRoot(document.getElementById('root')!).render(<main style={{ padding: 20, maxWidth: 460, color: 'var(--ink)', background: 'var(--paper)' }}><h1 style={{ marginBottom: 16 }}>Agents</h1>{records.map((record, index) => <Card key={index} record={record} index={index} />)}</main>);
});
