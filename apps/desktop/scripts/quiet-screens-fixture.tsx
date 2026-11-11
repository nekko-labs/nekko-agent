// Quiet-surfaces reference screens (docs/design-system.md, #2400): Security settings,
// the model library and change review side by side, from synthetic data. No credentials or user data.
const NOW = Date.now();
const changes = [
  { path: 'src/relay/transport.ts', original: 'export const a = 1;\nexport const b = 2;\nexport function send() {}\n', current: 'export const a = 1;\nexport const b = 3;\nexport function send(frame: Frame) {}\nexport function close() {}\n' },
  { path: 'spec/chat/tools.md', original: '', current: '# Tools\n\nThe relay tools.\n' },
];
(window as any).nekko = new Proxy(
  {
    listChanges: () => Promise.resolve(changes),
    onChangesUpdated: () => () => {},
  },
  { get: (t: any, k) => (k in t ? t[k] : () => Promise.resolve(null)) },
);
import('@fontsource-variable/geist');
import('@fontsource-variable/geist-mono');
import('../src/renderer/styles.css');
Promise.all([
  import('react'),
  import('react-dom/client'),
  import('../src/renderer/components/security/SecuritySettings'),
  import('../src/renderer/components/engine/ModelLibrary'),
  import('../src/renderer/components/DiffPane'),
]).then(([React, { createRoot }, { SecuritySettingsView }, { ModelLibrary }, { DiffPane }]) => {
  const h = React.createElement;
  const noop = () => {};
  const status: any = {
    available: true,
    enabled: true,
    methods: [
      { id: 'k1', name: 'YubiKey 5C', kind: 'security-key', addedAt: NOW - 21 * 86_400_000, lastUsedAt: NOW - 3_600_000, cloned: false },
      { id: 'k2', name: 'Windows Hello', kind: 'passkey', addedAt: NOW - 60 * 86_400_000, lastUsedAt: NOW - 86_400_000, cloned: false },
    ],
    totp: { addedAt: NOW - 60 * 86_400_000, lastUsedAt: NOW - 3 * 86_400_000 },
    recoveryLeft: 9,
    minMethods: 2,
    coverMs: 300_000,
    covered: {},
  };
  const models: any[] = [
    { id: 'qwen', name: 'Qwen3-14B-Instruct-Q4_K_M.gguf', path: 'C:/models/qwen3-14b-q4_k_m.gguf', sizeBytes: 8.9e9, quantization: 'Q4_K_M', parameterSize: '14B', maxContext: 32768, modality: 'chat', loaded: true, gpuFit: 'full', managed: true },
    { id: 'gemma', name: 'gemma-4-27b-it-Q5_K_M.gguf', path: 'C:/models/gemma-4-27b-q5_k_m.gguf', sizeBytes: 19.1e9, quantization: 'Q5_K_M', parameterSize: '27B', maxContext: 131072, modality: 'chat', loaded: false, gpuFit: 'partial', managed: true },
    { id: 'llava', name: 'llava-v2-8b-Q8_0.gguf', path: 'C:/models/llava-v2-8b-q8_0.gguf', sizeBytes: 8.5e9, quantization: 'Q8_0', parameterSize: '8B', modality: 'vision', hasProjector: false, loaded: false, gpuFit: 'full', managed: true },
  ];
  const col = (title: string, child: any, width = 460) =>
    h('section', { style: { width, minWidth: 0, background: 'var(--paper)', borderRadius: 14, padding: 20, overflow: 'hidden' } }, h('div', { className: 'mb-3 text-2xs text-ink-faint' }, title), child);
  document.documentElement.dataset.theme = 'dark';
  createRoot(document.getElementById('root')!).render(
    h('main', { style: { display: 'flex', gap: 16, padding: 16, alignItems: 'flex-start', background: 'var(--surface-2)', minHeight: '100vh' } },
      col('Settings › Security', h(SecuritySettingsView, { status, codes: null, totp: null, pairedPhones: 1, webAuthnBlocked: null, passkeys: true, rpId: 'localhost', onAddKey: () => false, onTotpBegin: noop, onTotpConfirm: noop, onTotpCancel: noop, onCodesSaved: noop, onEnable: noop, onDisable: noop, onRemove: noop, onRename: () => false, onNewCodes: noop, onCopyCodes: noop })),
      col('Models › On this computer', h(ModelLibrary, { providerId: 'local', models, canLoad: true, onChanged: noop, running: true, autoloadIds: new Set(['qwen']) }), 640),
      col('Change review', h('div', { style: { height: 460, margin: -20 } }, h(DiffPane, { sessionId: 's1' })), 420),
    ),
  );
});
