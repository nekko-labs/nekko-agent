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

describe('account emails in the picker', () => {
  it('names the signed-in account next to the provider, in its own case', () => {
    emails.byToken = { 'claude:a': 'Davide@Example.com' };
    try {
      const providers = [{ id: 'a', kind: 'anthropic' as const, label: 'Anthropic (Claude)', enabled: true, baseUrl: '', auth: 'subscription' as const, tokenKey: 'claude:a' }];
      const out = renderToStaticMarkup(<ModelPicker expanded open providers={providers} providerId="a" modelId="m" models={[{ id: 'm', providerId: 'a', name: 'Claude Opus' }]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(out).toContain('Anthropic (Claude)<span class="font-normal normal-case tracking-normal" data-account-email="true"> · Davide@Example.com</span>');
      const chip = renderToStaticMarkup(<ModelPicker open={false} providers={providers} providerId="a" modelId="m" models={[{ id: 'm', providerId: 'a', name: 'Claude Opus' }]} onOpenChange={() => {}} onProvider={() => {}} onModel={() => {}} />);
      expect(chip).toContain('Model: Claude Opus · Anthropic (Claude) · Davide@Example.com');
    } finally { emails.byToken = {}; }
  });
});
