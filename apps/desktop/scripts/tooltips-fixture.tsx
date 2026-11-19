// Tooltip evidence: real PR and issue chips (synthetic bridge, no network), a
// HoverTip icon control and native-title controls, with the app-wide title
// layer mounted when this revision has one.
const pr = (number: number, state: string, title: string, extra = {}) => ({
  url: `https://github.com/nekko-labs/nekko-agent/pull/${number}`, owner: 'nekko-labs', repo: 'nekko-agent', number, title, state,
  isDraft: false, additions: 184, deletions: 37, changedFiles: 6, checks: 'passing', ...extra,
});
const prs: Record<string, unknown> = {
  'https://github.com/nekko-labs/nekko-agent/pull/2954': pr(2954, 'open', 'iPhone model picker: size or context per model, folded dated snapshots, limits under each provider'),
  'https://github.com/nekko-labs/nekko-agent/pull/2950': pr(2950, 'merged', 'Rounder composer chips in the wall view'),
};
(window as any).nekko = {
  getPrInfo: async (url: string) => prs[url] ?? null,
  getIssueInfo: async (url: string) => ({ kind: 'issue', url, owner: 'nekko-labs', repo: 'nekko-agent', number: 2955, title: 'Tooltips look like plain system boxes; give them our quiet style', state: 'open', stateReason: null }),
  openPath: async () => {},
};
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/PrLinkChip'), import('../src/renderer/components/HoverTip'), import('../src/renderer/gentleface-icons')]).then(async ([React, { createRoot }, { PrLinkChip, IssueLinkChip }, { HoverTip }, { GfIcon }]) => {
  await import('@fontsource-variable/geist');
  await import('@fontsource-variable/geist-mono');
  await import('../src/renderer/styles.css');
  // The layer is new with this change; the base revision has none.
  const layer = await import('../src/renderer/components/TitleTips').then((m: any) => m.TitleTips).catch(() => null);
  const h = React.createElement;
  const icon = (name: any, title: string, id: string) => h('button', { id, title, className: 'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-surface-2' }, h(GfIcon, { name, className: 'h-4 w-4' }));
  document.body.style.background = 'var(--paper)';
  createRoot(document.getElementById('root')!).render(h('div', { style: { padding: '120px 48px', maxWidth: 720, color: 'var(--ink)', fontSize: 14, lineHeight: 1.6 } },
    h('p', null, 'Opened ', h('span', { id: 'pr-open' }, h(PrLinkChip, { href: 'https://github.com/nekko-labs/nekko-agent/pull/2954' })), ' for the picker.'),
    h('p', { style: { marginTop: 120 } }, 'It builds on ', h('span', { id: 'pr-merged' }, h(PrLinkChip, { href: 'https://github.com/nekko-labs/nekko-agent/pull/2950' })),
      ' and closes ', h('span', { id: 'issue' }, h(IssueLinkChip, { href: 'https://github.com/nekko-labs/nekko-agent/issues/2955', label: '#2955' })), '.'),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 120 } },
      icon('folder-open', 'Open the project folder', 'native-copy'),
      icon('terminal', 'Open a terminal here', 'native-retry'),
      h(HoverTip, { label: 'Hide agents' }, h('button', { id: 'hover-tip', className: 'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft' }, h(GfIcon, { name: 'sidebar-collapse', className: 'h-4 w-4' })))),
    layer && h(layer)));
  (window as any).tooltipsFixtureReady = true;
});
