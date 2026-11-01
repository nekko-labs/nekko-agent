// Isolated model-picker fixture: no credentials, provider requests, or user data.
(window as any).nekko = new Proxy({}, { get: () => () => Promise.resolve(null) });
import('@fontsource-variable/inter-tight');
import('../src/renderer/styles.css');
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/agent-console/ModelPicker')]).then(([React, { createRoot }, { ModelPicker }]) => {
  const providers = [
    { id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT', baseUrl: '', enabled: true },
    { id: 'claude', kind: 'claude-code', label: 'Claude Agent', baseUrl: '', enabled: true },
  ];
  const models = [
    { id: 'gpt-6-sol', providerId: 'chatgpt', name: 'GPT-6 Sol' },
    { id: 'gpt-6.1-sol', providerId: 'chatgpt', name: 'GPT-6.1 Sol', availability: { status: 'ready', detail: 'Not listed for this account. You can try it, but the provider may reject it.' } },
    { id: 'opus', providerId: 'claude', name: 'Claude Opus' },
    { id: 'sonnet', providerId: 'claude', name: 'Claude Sonnet' },
  ];
  document.documentElement.dataset.theme = 'dark';
  const root = createRoot(document.getElementById('root')!);
  const render = (providerId: string, modelId: string, resolvedModelId?: string) => root.render(React.createElement('main', { style: { width: 'min(380px, 100vw)', height: '620px', margin: '60px auto' } }, React.createElement(ModelPicker, { expanded: true, open: true, readOnly: true, providers: providers.filter(p => p.id === providerId), models: models.filter(m => m.providerId === providerId), providerId, modelId, resolvedModelId, onOpenChange: () => {}, onProvider: () => {}, onModel: (_provider: string, model: string) => { (window as any).catalogFixture.picked = model; } })));
  (window as any).catalogFixture = { render };
  render('chatgpt', 'gpt-6-sol');
});
