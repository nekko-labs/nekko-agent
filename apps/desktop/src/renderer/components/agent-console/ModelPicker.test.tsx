import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../../store.js', async (original) => {
  const actual = await original<typeof import('../../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
const emails = vi.hoisted(() => ({ byToken: {} as Record<string, string> }));
vi.mock('../../accountEmails.js', async (orig) => ({ ...(await orig<typeof import('../../accountEmails.js')>()), useAccountEmails: () => emails.byToken }));
import { useStore } from '../../store.js';
import { ModelPicker } from './ModelPicker.js';

describe('default model in the picker', () => {
  it('hides settings mutation controls in read-only mode', () => {
    const props = { expanded: true, open: true, providers: [{ id: 'p', kind: 'openai' as const, label: 'Provider', enabled: true, baseUrl: 'http://localhost' }], providerId: 'p', modelId: 'm', models: [{ id: 'm', providerId: 'p', name: 'Model' }], onOpenChange: () => {}, onProvider: () => {}, onModel: () => {} };
    expect(renderToStaticMarkup(<ModelPicker {...props} />)).toContain('Star Model');
    const out = renderToStaticMarkup(<ModelPicker {...props} readOnly />);
    expect(out).not.toContain('Star Model');
    expect(out).toContain('role="option"');
  });
  it('pins a missing default as disabled above other models', () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, defaultProviderId: 'p', defaultModelId: 'missing' } as NonNullable<typeof prev> });
    try {
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={[{id:'p',kind:'openai',label:'Provider',enabled:true,baseUrl:'http://localhost'}]} providerId="p" modelId="other" models={[{id:'other',providerId:'p',name:'Other model'}]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(out).toContain('Default · unavailable');
      expect(out).toContain('disabled="" aria-disabled="true"');
      expect(out.indexOf('missing')).toBeLessThan(out.indexOf('Other model'));
    } finally { useStore.setState({settings:prev}); }
  });
  it('does not call a GPT Sol default unavailable before its provider catalog loads', () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, defaultProviderId: 'chatgpt', defaultModelId: 'gpt-6.1-sol' } as NonNullable<typeof prev> });
    try {
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={[{id:'chatgpt',kind:'chatgpt',label:'ChatGPT',enabled:true,baseUrl:'http://localhost'}]} providerId={null} modelId={null} models={[]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(out).toContain('Default · loading…');
      expect(out).not.toContain('Default · unavailable');
    } finally { useStore.setState({settings:prev}); }
  });
  it('identifies an available default without duplicating its row', () => {
    const prev = useStore.getState().settings;
    useStore.setState({ settings: { ...prev, defaultProviderId: 'p', defaultModelId: 'other' } as NonNullable<typeof prev> });
    try {
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={[{id:'p',kind:'openai',label:'Provider',enabled:true,baseUrl:'http://localhost'}]} providerId="p" modelId="other" models={[{id:'other',providerId:'p',name:'Other model'}]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} recent={['p::other']} />);
      expect(out).toContain('>Default<');
      expect(out.match(/role="option"/g)).toHaveLength(1);
    } finally { useStore.setState({settings:prev}); }
  });
});

describe('local models and provider headings', () => {
  it('shows a local model by its short name with the file path beneath, under an ink provider heading', () => {
    const providers = [{ id: 'eng', kind: 'llamacpp' as const, label: 'Nekko Agent engine', enabled: true, baseUrl: 'http://127.0.0.1:11500/v1' }];
    const models = [
      { id: 'lmstudio/lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M', providerId: 'eng', name: 'Qwen3 8B', details: { path: 'D:/models/Qwen3-8B-Q4_K_M.gguf' } },
      // An older engine that sent no name: the id's last segment is the name.
      { id: 'lmstudio/lmstudio-community/Muse-Glimmer-30B', providerId: 'eng', name: 'lmstudio/lmstudio-community/Muse-Glimmer-30B' },
    ];
    const out = renderToStaticMarkup(<ModelPicker expanded open providers={providers} providerId="eng" modelId={null} models={models} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
    expect(out).toContain('data-model-name="true">Qwen3 8B<');
    expect(out).toContain('D:/models/Qwen3-8B-Q4_K_M.gguf');
    expect(out).toContain('data-model-name="true">Muse-Glimmer-30B<');
    expect(out).toContain('>lmstudio/lmstudio-community</span>');
    expect(out).not.toContain('data-model-name="true">lmstudio/');
    expect(out).toMatch(/text-\[12px\] font-semibold text-ink" data-provider-heading="true">Nekko Agent engine/);
  });
  it('keeps a cloud id with a slash as its name and price line', () => {
    const providers = [{ id: 'or', kind: 'openrouter' as const, label: 'OpenRouter', enabled: true, baseUrl: 'https://openrouter.ai/api/v1' }];
    const out = renderToStaticMarkup(<ModelPicker expanded open providers={providers} providerId="or" modelId={null} models={[{ id: 'meta/llama', providerId: 'or', name: 'meta/llama' }]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
    expect(out).toContain('data-model-name="true">meta/llama<');
  });
});

describe('account emails in the picker', () => {
  it('names the signed-in account next to the provider, in its own case', () => {
    emails.byToken = { 'claude:a': 'Davide@Example.com' };
    try {
      const providers = [{ id: 'a', kind: 'anthropic' as const, label: 'Claude API', enabled: true, baseUrl: '', auth: 'subscription' as const, tokenKey: 'claude:a' }];
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={providers} providerId="a" modelId="m" models={[{ id: 'm', providerId: 'a', name: 'Claude Opus' }]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(out).toContain('Claude API<span class="font-normal normal-case tracking-normal text-ink-faint" data-account-email="true"> · Davide@Example.com</span>');
      const chip = renderToStaticMarkup(<ModelPicker open={false} providers={providers} providerId="a" modelId="m" models={[{ id: 'm', providerId: 'a', name: 'Claude Opus' }]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(chip).toContain('Model: Claude Opus · Claude API · Davide@Example.com');
    } finally { emails.byToken = {}; }
  });
});

describe('model chip name priority', () => {
  it('wraps the complete model name rather than ellipsizing it for the account label', () => {
    const out = renderToStaticMarkup(<ModelPicker open={false} providers={[{id:'p',kind:'anthropic',label:'Claude API very long account',enabled:true,baseUrl:''}]} providerId="p" modelId="m" models={[{id:'m',providerId:'p',name:'Claude Opus 4.6'}]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
    expect(out).toContain('whitespace-normal break-words text-left');
    expect(out).toContain('data-model-chip-name="true">Claude Opus 4.6</span>');
    expect(out).toContain('ctl-caret shrink-0');
  });
});

describe('account switcher', () => {
  const gpt = (id: string, tokenKey: string) => ({ id, kind: 'chatgpt' as const, label: 'ChatGPT', enabled: true, baseUrl: 'http://localhost', auth: 'subscription' as const, tokenKey });
  const base = { expanded: true, open: true, modelId: 'gpt-6', models: [{ id: 'gpt-6', providerId: 'a', name: 'GPT 6' }], onOpenChange: () => {}, onProvider: () => {}, onModel: () => {} };
  it('lists each account of the current vendor by its email, the current one checked', () => {
    emails.byToken = { 'chatgpt:a': 'me@home.example', 'chatgpt:b': 'me@work.example' };
    try {
      const out = renderToStaticMarkup(<ModelPicker {...base} providers={[gpt('a', 'chatgpt:a'), gpt('b', 'chatgpt:b')]} providerId="a" />);
      expect(out).toContain('data-account-switcher');
      expect(out).toMatch(/aria-checked="true"[^>]*>me@home\.example</);
      expect(out).toMatch(/aria-checked="false"[^>]*>me@work\.example</);
      expect(out).toContain('Use GPT 6 on me@work.example');
    } finally { emails.byToken = {}; }
  });
  it('shows no switcher with a single account', () => {
    const out = renderToStaticMarkup(<ModelPicker {...base} providers={[gpt('a', 'chatgpt:a')]} providerId="a" />);
    expect(out).not.toContain('data-account-switcher');
  });
  it('says a Claude Agent switch starts a new Claude Code conversation', () => {
    const cc = (id: string, label: string, account?: string) => ({ id, kind: 'claude-code' as const, label, enabled: true, baseUrl: '', ...(account ? { claudeCode: { account } } : {}) });
    const out = renderToStaticMarkup(<ModelPicker {...base} modelId="opus" models={[{ id: 'opus', providerId: 'cc', name: 'Opus' }]} providers={[cc('cc', 'Claude Agent'), cc('ccw', 'Claude Agent · Work', 'work')]} providerId="cc" />);
    expect(out).toContain('Claude Agent · Work');
    expect(out).toContain('new Claude Code conversation');
  });
});
