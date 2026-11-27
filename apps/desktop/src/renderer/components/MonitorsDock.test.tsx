import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
import { cssRule, stylesheet } from '../tests/css.js';
const storeState = vi.hoisted(() => ({ value: { settings: {} } as Record<string, unknown> }));
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select(storeState.value) }));
vi.mock('../simpleMode.js', async (original) => ({ ...(await original<object>()), useShown: () => true }));
const quota = vi.hoisted(() => ({ byToken: {} as Record<string, any>, answered: new Set<string>(), nextRefreshAt: null as number | null }));
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => quota }));
const emails = vi.hoisted(() => ({ byToken: {} as Record<string, string> }));
vi.mock('../accountEmails.js', async (orig) => ({ ...(await orig<typeof import('../accountEmails.js')>()), useAccountEmails: () => emails.byToken }));
vi.mock('./AutomationsPane.js', () => ({ AutomationsPane: () => null }));
const resources = vi.hoisted(() => ({ gpu: null as import('@nekko-agent/shared').GpuStats | null, watched: null as string | null }));
vi.mock('./ResourceMonitor.js', () => ({ MonitorComputerSwitch: () => null, useWatchedComputer: () => resources.watched, useMonitors: () => ({ cpu: true, memory: true, gpu: true, vram: true }), useResourceSample: () => ({ system: { cpuPct: 18, memUsedMB: 2048, memTotalMB: 8192 }, gpu: resources.gpu }) }));
import { ComputerModelServer, LocalModels, MonitorsDock, MonitorsToggle, readComputerUtilization } from './MonitorsDock.js';
function render(minimized = false) {
  const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: false, budget: false, hardware: true, localModels: false }, minimized: { ...DEFAULT_WALL_STATE.dock.minimized, hardware: minimized } } };
  return renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
}
describe('monitors panel show and hide', () => {
  const props = { setState: vi.fn(), tasks: [], running: new Set<string>(), now: 0, sessions: [], providers: [], usage: null, onOpenChat: vi.fn(), onOpenModels: vi.fn() };
  it('puts an icon-only hide button last in the header, explained by a tooltip', () => {
    const html = render();
    const header = html.slice(html.indexOf('monitors-dock__toolbar'), html.indexOf('</header>'));
    expect(header).toContain('aria-label="Hide the monitors panel"');
    expect(header).toContain('data-hover-tip="Hide monitors"');
    // Top right: after Configure, the last control in the header.
    expect(header.indexOf('Configure monitors')).toBeLessThan(header.indexOf('Hide the monitors panel'));
    expect(header.slice(header.indexOf('Hide the monitors panel')).match(/<button/g)).toBeNull();
  });
  it('leaves only its show button where it was when hidden, and toggles the saved setting', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, show: false } };
    const html = renderToStaticMarkup(<MonitorsDock {...props} state={state} />);
    expect(html).toMatch(/^<div class="monitors-dock-collapsed" data-dock-side="right">/);
    expect(html).toContain('aria-label="Show the monitors panel"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('Hardware');
    // The button itself flips the saved setting through onToggle.
    const onToggle = vi.fn();
    const tip = MonitorsToggle({ show: false, side: 'right', onToggle }) as React.ReactElement<{ children: React.ReactElement<{ onClick: () => void }> }>;
    tip.props.children.props.onClick();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('wall dock presentation', () => {
  it('pairs each GPU name with its own utilization, including unavailable readings', () => {
    resources.gpu = { source: 'nvidia-smi', totalMB: 0, usedMB: 0, freeMB: 0, devices: [
      { name: 'NVIDIA RTX 4090', memoryTotalMB: 0, memoryUsedMB: 0, memoryFreeMB: 0, utilizationPct: 12 },
      { name: 'NVIDIA RTX 3090', memoryTotalMB: 0, memoryUsedMB: 0, memoryFreeMB: 0, utilizationPct: 87 },
      { name: 'Intel Arc', memoryTotalMB: 0, memoryUsedMB: 0, memoryFreeMB: 0 },
    ] };
    try {
      const html = render();
      expect(html).toContain('aria-label="GPU 1: NVIDIA RTX 4090" aria-valuemin="0" aria-valuemax="100" aria-valuenow="12"');
      expect(html).toContain('aria-label="GPU 2: NVIDIA RTX 3090" aria-valuemin="0" aria-valuemax="100" aria-valuenow="87"');
      expect(html).toContain('GPU 3: Intel Arc');
      expect(html).not.toContain('peak device');
      expect(html).toContain('Unavailable');
    } finally { resources.gpu = null; }
  });
  it('clarifies stale quota without claiming an active refresh', () => {
    quota.byToken.plan = { updatedAt: 1000, staleAfterMs: 1000, windows: [] };
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={5000} sessions={[]} providers={[{ id: 'plan', kind: 'chatgpt', label: 'Plan', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'plan' }]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('monitors-dock__utilization');
    expect(html).toContain('Refresh provider quota');
    expect(html).not.toContain('Quota may be outdated');
    expect(html).not.toContain('Last quota update:');
    expect(html).not.toContain('Stale quota · awaiting refresh');
    quota.byToken = {};
  });
  it.each([
    [0, 100, 'var(--success)'],
    [17, 83, 'var(--success)'],
    [40, 60, 'var(--success)'],
    [60, 40, 'var(--success)'],
    [60.25, 39.75, 'var(--warning)'],
    [79, 21, 'var(--warning)'],
    [80, 20, 'var(--danger)'],
    [83, 17, 'var(--danger)'],
    [100, 0, 'var(--danger)'],
  ])('shows ChatGPT quota used %s as %s left with usage-based warnings', (used, left, tone) => {
    quota.byToken = { synthetic: { windows: [{ label: '7-day', usedPercent: used, resetAt: 0 }], updatedAt: 0, staleAfterMs: 60000 } };
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[{ id: 'chatgpt', baseUrl: '', kind: 'openai', auth: 'subscription', tokenKey: 'synthetic', enabled: true, label: 'ChatGPT' }]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain(`${Math.round(left)}% left`);
    expect(html).toContain(`aria-valuenow="${left}"`);
    expect(html).toContain(`width:${left}%;background:${tone}`);
    quota.byToken = {};
  });
  it.each(['auth_expired', 'signed_out'] as const)('offers Sign in again right in the panel for %s', (kind) => {
    quota.byToken = {};
    (quota as any).problems = { chatgpt: { kind, at: 0 } };
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[{ id: 'chatgpt-sub', kind: 'chatgpt', label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'chatgpt' }]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('data-dock-signin');
    expect(html).toContain('>Sign in again</button>');
    expect(html).not.toContain('in Settings');
    expect(html).toContain(kind === 'signed_out' ? 'Not signed in.' : 'Sign-in expired.');
    (quota as any).problems = {};
  });
  it('tells two ChatGPT plans apart by the email each is signed in as', () => {
    quota.byToken = {};
    (quota as any).problems = {};
    emails.byToken = { 'chatgpt:a': 'davide@example.com', 'chatgpt:b': 'davide@work.example' };
    try {
      const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
      const providers = [
        { id: 'p1', kind: 'chatgpt' as const, label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription' as const, tokenKey: 'chatgpt:a' },
        { id: 'p2', kind: 'chatgpt' as const, label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription' as const, tokenKey: 'chatgpt:b' },
        { id: 'p3', kind: 'chatgpt' as const, label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription' as const, tokenKey: 'chatgpt:c' },
      ];
      const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={providers} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
      expect(html).toContain('ChatGPT<span class="monitors-dock__account" data-account-email="true"> · davide@example.com</span>');
      expect(html).toContain('davide@work.example');
      // A plan signed in before emails were recorded keeps the bare label.
      expect(html.match(/data-account-email/g)).toHaveLength(2);
    } finally { emails.byToken = {}; }
  });
  it('tells a Claude plan card from an older build to use an API key, with no sign-in', () => {
    quota.byToken = {};
    (quota as any).problems = {};
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[{ id: 'old', kind: 'anthropic', label: 'Claude', baseUrl: '', enabled: true, auth: 'subscription' }]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('Claude plan sign-in is no longer available');
    expect(html).not.toContain('data-dock-signin');
  });
  it('splits Budget into API spend and estimated savings, and never asks for a monthly budget', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: false, budget: true, hardware: false, localModels: false } } };
    const usage = { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, bySession: {}, byProvider: {}, bySessionCost: {}, daily: [{ date: '1970-01-01', input: 0, output: 0, cost: 0, avoidedCosts: { local: 1.23, subscription: 4.56, benchmarkTokens: 100, unpricedTokens: 200 } }], avoidedCosts: { local: 1.23, subscription: 4.56, benchmarkTokens: 100, unpricedTokens: 200 } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={usage} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    // The Vitals panel is gone from the dock.
    expect(html).not.toContain('tokens today');
    // Metered spend excludes plan and local usage; savings value both at API prices.
    expect(html).toContain('aria-label="API &amp; cloud spend"');
    expect(html).toContain('aria-label="Estimated savings"');
    const actual = html.slice(html.indexOf('data-spend="actual"'), html.indexOf('data-spend="theoretical"'));
    expect(actual).toContain('$0.00');
    const theoretical = html.slice(html.indexOf('data-spend="theoretical"'), html.indexOf('monitors-dock__breakdown'));
    expect(theoretical).toContain('$5.79');
    expect(html).toContain('Local model savings</dt><dd>$1.23');
    expect(html).toContain('Plan usage value</dt><dd>$4.56');
    // Nothing paid: the whole bar is savings.
    expect(html).toContain('0% metered');
    expect(html).not.toContain('data-part="actual"');
    expect(html).not.toContain('Local AI saved');
    expect(html).toContain('200 unpriced tokens excluded');
    expect(html).toContain('Resize Budget monitor height');
    expect(html).not.toContain('Monthly budget (USD)');
  });
  it('filters Budget spend and tokens with the Insights time ranges', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: false, budget: true, hardware: false, localModels: false } } };
    const now = Date.parse('2026-10-08T12:00:00Z');
    const usage: import('@nekko-agent/shared').UsageSummary = { avoidedCosts: { subscription: 2200, local: 0, benchmarkTokens: 0, unpricedTokens: 0 }, totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, bySession: {}, byProvider: {}, bySessionCost: {}, daily: [
      { date: '2026-10-08', input: 100, output: 50, cost: 1, bySessionCost: { recent: 1 }, localTokens: 42, modelIds: ['recent-local'], avoidedCosts: { local: 2.34, subscription: 5.67, benchmarkTokens: 42, unpricedTokens: 7 } },
      { date: '2026-08-01', input: 1000, output: 500, cost: 10, bySessionCost: { old: 10 }, localTokens: 9999, modelIds: ['old-model'], avoidedCosts: { local: 1234, subscription: 2200, benchmarkTokens: 9999, unpricedTokens: 8888 } },
    ] };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={now} sessions={[]} providers={[]} usage={usage} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('aria-label="Budget time range"');
    for (const r of ['today', '1wk', '1m', '6m', '1y', 'all-time']) expect(html).toContain(`>${r}</button>`);
    // Default 1m (last 30 days) excludes August.
    expect(html).toContain('last 30 days');
    expect(html).not.toContain('$2200.00');
    expect(html).not.toContain('est. · all time');
    expect(html).toContain('100 in · 50 out');
    expect(html).toContain('$1.00');
    expect(html).toContain('$2.34');
    expect(html).toContain('$5.67');
    // Savings sum both comparisons; the bar shows the metered share of the API-price total.
    expect(html).toContain('$8.01');
    expect(html).toContain('$9.01 at API prices · 11% metered');
    expect(html).toContain('data-part="actual" style="width:');
    expect(html).toContain('Top paid agent</dt><dd><span class="monitors-dock__breakdown-name">Chat unavailable</span>$1.00');
    expect(html).toContain('42 tokens');
    expect(html).toContain('42 local tokens use the fallback');
    expect(html).toContain('7 unpriced tokens excluded');
    expect(html).toContain('recent-local:');
    expect(html).not.toContain('old-model:');
    expect(html).not.toContain('9999');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('bg-accent/10');
    // No paid pictures in the range: no row for them.
    expect(html).not.toContain('Paid pictures');
    const pictures = { ...usage, daily: [{ ...usage.daily[0]!, pictures: 2, pictureCost: 0.071 }] };
    const withPictures = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={now} sessions={[]} providers={[]} usage={pictures} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(withPictures).toContain('data-row="pictures"><dt>Paid pictures</dt><dd>$0.07<small>2 pictures</small>');
  });
  it('uses named icon controls and meters with exact numbers below', () => {
    const html = render();
    expect(html).toContain('aria-label="Minimize Hardware monitor"');
    expect(html).toContain('aria-label="Resize monitors"');
    expect(html).toContain('role="meter" aria-label="CPU"');
    expect(html).toContain('2.0 / 8.0 GiB (25%)');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('>Minimize</button>');
  });
  it('resizes a side dock across and a top or bottom dock up and down, from the edge facing the wall', () => {
    const props = { setState: vi.fn(), tasks: [], running: new Set<string>(), now: 0, sessions: [], providers: [], usage: null, onOpenChat: vi.fn(), onOpenModels: vi.fn() };
    const at = (side: 'left' | 'right' | 'top' | 'bottom') => renderToStaticMarkup(<MonitorsDock {...props} state={{ ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, side } }} />);
    for (const side of ['left', 'right'] as const) {
      const html = at(side);
      expect(html.match(/aria-label="Resize monitors"/g)).toHaveLength(1);
      expect(html).toMatch(/aria-label="Resize monitors" aria-orientation="vertical"/);
    }
    for (const side of ['top', 'bottom'] as const) {
      const html = at(side);
      expect(html.match(/aria-label="Resize monitors"/g)).toHaveLength(1);
      expect(html).toMatch(/aria-label="Resize monitors" aria-orientation="horizontal" aria-valuemin="120" aria-valuemax="360" aria-valuenow="360"/);
      expect(html).toContain('--dock-height:360px');
    }
    const css = stylesheet('components/monitorsDock.css');
    // The dragged height is the dock's ceiling: it stays as tall as its monitors below it.
    expect(cssRule(css, '.monitors-dock[data-dock-side="top"]')['max-height']).toBe('var(--dock-height,360px)');
    const edge = '.monitors-dock:is([data-dock-side="top"],[data-dock-side="bottom"]) .monitors-dock__resize';
    expect(cssRule(css, edge)).toMatchObject({ bottom: '-9px', height: '10px', cursor: 'row-resize' });
    expect(cssRule(css, '.monitors-dock[data-dock-side="bottom"] .monitors-dock__resize')).toMatchObject({ top: '-9px', bottom: 'auto' });
    // The grip sits past the dock's edge, so an open top or bottom dock does not clip it.
    expect(cssRule(css, '.monitors-dock:is([data-dock-side="top"],[data-dock-side="bottom"])[data-panel-open="true"]')['clip-path']).toBe('inset(-10px)');
  });
  it('replaces a minimized panel with a restore icon in the top row', () => {
    const html = render(true);
    expect(html).toContain('aria-label="Minimized monitors"');
    expect(html).toContain('aria-label="Expand Hardware monitor"');
    expect(html).not.toContain('aria-label="Hardware monitor"');
    expect(html).not.toContain('role="meter"');
  });
  it('gives Utilization and Automations their Gentleface icons, lit like a restore button when the header is hovered', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: true, utilization: true, budget: false, hardware: false, localModels: false } } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('data-gf-icon="bar-chart-horizontal"');
    expect(html).toContain('data-gf-icon="bolt"');
    expect(html.match(/class="monitors-dock__monitor-header" data-icon-hover="true"/g)).toHaveLength(2);
    expect(html).not.toContain('Insights');
    const css = stylesheet('components/monitorsDock.css');
    expect(cssRule(css, '.monitors-dock__monitor-icon').color).toBe('var(--accent)');
    expect(cssRule(css, '.monitors-dock__minimized button').color).toBe('var(--accent)');
  });
  it('leads each Utilization provider with its logo', () => {
    quota.byToken = {};
    (quota as any).problems = {};
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
    const providers = [
      { id: 'cg', kind: 'chatgpt' as const, label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription' as const, tokenKey: 'cg' },
      { id: 'or', kind: 'openrouter' as const, label: 'OpenRouter', baseUrl: '', enabled: true },
    ];
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={providers} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('<div class="monitors-dock__provider-head"><span class="provider-mark provider-mark-tile"');
    expect(html).toContain('src="./providers/openai.svg"');
    expect(html).toContain('src="./providers/openrouter.svg"');
  });
});

describe('Local models monitor', () => {
  const GB = 1024 ** 3;
  const install = { binPath: '/x/llama-server', available: [] };
  const settings = { port: 11500, bind: 'local', autoStart: false, jitLoad: true, idleTtlSeconds: 900, maxLoaded: 2 };
  const status = (over: Record<string, unknown> = {}) => ({ install, running: true, resident: [], log: [], port: 11500, settings, ...over }) as any;
  const models = [{ id: 'qwen', name: 'Qwen3 8B', path: '/m/qwen.gguf', sizeBytes: 5 * GB }, { id: 'gemma', name: 'Gemma 3 27B', path: '/m/gemma.gguf', sizeBytes: 16 * GB }] as any;
  it('is offered in Configure and on by default, under Hardware', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { ...DEFAULT_WALL_STATE.dock.monitors, utilization: false, budget: false, automations: false } } };
    const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(DEFAULT_WALL_STATE.dock.monitors.localModels).toBe(true);
    expect(html).toContain('aria-label="Local models monitor"');
    expect(html.indexOf('aria-label="Hardware monitor"')).toBeLessThan(html.indexOf('aria-label="Local models monitor"'));
  });
  it('lists each resident model with where it runs and a settings jump', () => {
    const resident = [
      { id: 'qwen', loadedOn: 'gpu', gpuLayers: 36, totalLayers: 36, contextLength: 32768, vramBytes: 6 * GB },
      { id: 'gemma', loadedOn: 'gpu+cpu', gpuLayers: 38, totalLayers: 62, contextLength: 16384, sizeBytes: 16 * GB },
    ];
    const html = renderToStaticMarkup(<LocalModels initial={{ status: status({ resident }), models }} />);
    expect(html).toContain('Qwen3 8B');
    expect(html).toContain('on GPU · 36/36 layers');
    expect(html).toContain('32k context · 6.0 GB');
    expect(html).toContain('Gemma 3 27B');
    expect(html).toContain('GPU + CPU · 38/62 layers');
    expect(html).toContain('data-local-model-settings="qwen"');
    expect(html).toContain('data-local-model-settings="gemma"');
    expect(html).toContain('aria-label="Open Gemma 3 27B settings"');
    expect(html).toContain('Open Model Server');
  });
  it('falls back to the model id when the library has no entry for it', () => {
    const html = renderToStaticMarkup(<LocalModels initial={{ status: status({ resident: [{ id: 'ghost' }] }), models: [] }} />);
    expect(html).toContain('ghost');
    expect(html).toContain('data-local-model-settings="ghost"');
  });
  it('says plainly when nothing is loaded, the server is stopped, or there is no engine', () => {
    const idle = renderToStaticMarkup(<LocalModels initial={{ status: status(), models }} />);
    expect(idle).toContain('>Running</p>');
    expect(idle).toContain('No models are currently loaded.');
    expect(idle).toContain('data-gf-icon="beach"');
    expect(renderToStaticMarkup(<LocalModels initial={{ status: status({ running: false }), models }} />)).toContain('The model server is stopped.');
    const none = renderToStaticMarkup(<LocalModels initial={{ status: status({ install: { available: [] } }), models }} />);
    expect(none).toContain('No local engine installed.');
    expect(none).toContain('Set up a local model');
    expect(none).not.toContain('data-local-model-settings');
    expect(none).not.toContain('>Running</p>');
  });
  it('offers Unload on every loaded model, picture models included, and Unload all for more than one', () => {
    const pictures = [...models, { id: 'flux', name: 'FLUX.1 schnell', path: '/m/flux.gguf', sizeBytes: 7 * GB, modality: 'image' }] as any;
    const one = renderToStaticMarkup(<LocalModels initial={{ status: status({ resident: [{ id: 'flux', loadedOn: 'gpu', vramBytes: 9 * GB }] }), models: pictures }} />);
    expect(one).toContain('data-local-model-unload="flux"');
    expect(one).toContain('aria-label="Unload FLUX.1 schnell"');
    expect(one).toContain('image gen');
    expect(one).toContain('title="Picture settings"');
    expect(one).not.toContain('Unload all');
    const two = renderToStaticMarkup(<LocalModels initial={{ status: status({ resident: [{ id: 'flux' }, { id: 'qwen' }] }), models: pictures }} />);
    expect(two).toContain('data-local-model-unload="qwen"');
    expect(two).toContain('data-local-models-unload-all');
  });
  it('draws Settings and Load as Gentleface icons named by their tooltip', () => {
    storeState.value = { settings: {}, sessions: [{ providerId: 'nekko-engine', modelId: 'gemma', updatedAt: 20 }] };
    try {
      const html = renderToStaticMarkup(<LocalModels initial={{ status: status(), models }} />);
      const row = html.slice(html.indexOf('data-local-model-shortcut="gemma"'));
      expect(row).toMatch(/data-local-model-settings="gemma"[^>]*title="Settings: GPU offload, context and memory"[^>]*><span data-gf-icon="settings"/);
      expect(row).toMatch(/data-local-model-load="gemma"[^>]*title="Load"[^>]*><span data-gf-icon="play-circle"/);
      expect(row).not.toContain('>Load</button>');
      expect(row).not.toContain('>Settings</button>');
    } finally { storeState.value = { settings: {} }; }
  });
  it('lists recent models that are not loaded by name alone, with Settings and Load, and no Starred group', () => {
    const more = [...models, { id: 'phi', name: 'Phi 4', path: '/m/phi.gguf', sizeBytes: 2 * GB, quantization: 'Q4_K_M' }] as any;
    storeState.value = {
      settings: { favoriteModels: ['nekko-engine::gemma', 'nekko-engine::qwen'] },
      sessions: [{ providerId: 'nekko-engine', modelId: 'phi', updatedAt: 10 }, { providerId: 'nekko-engine', modelId: 'qwen', updatedAt: 20 }],
    };
    try {
      const html = renderToStaticMarkup(<LocalModels initial={{ status: status({ resident: [{ id: 'qwen' }] }), models: more }} />);
      expect(html).not.toContain('data-local-models-group="starred"');
      expect(html).not.toContain('data-local-model-star');
      // Starred but never used: not offered.
      expect(html).not.toContain('data-local-model-load="gemma"');
      // Loaded already: it has its own row with Unload, not a Load shortcut.
      expect(html).not.toContain('data-local-model-load="qwen"');
      const recent = html.slice(html.indexOf('data-local-models-group="recent"'));
      expect(recent).toContain('data-local-model-load="phi"');
      expect(recent).toContain('data-local-model-settings="phi"');
      // Just the name: no size or quantization line under it.
      expect(recent).not.toContain('Q4_K_M');
      expect(recent).not.toContain('monitors-dock__note');
      // Offered while the server is stopped too: Load starts it.
      expect(renderToStaticMarkup(<LocalModels initial={{ status: status({ running: false }), models: more }} />)).toContain('data-local-model-load="phi"');
    } finally { storeState.value = { settings: {} }; }
  });
});

describe('monitors follow the computer switch', () => {
  it("reads a connected computer's providers, quota by provider id, and usage through its gate", async () => {
    const calls: unknown[][] = [];
    const read = vi.fn(async (id: string, channel: string, args: unknown[] = []) => {
      calls.push([id, channel, ...args]);
      if (channel === 'providers:list') return [{ id: 'cg', kind: 'chatgpt', label: 'ChatGPT', enabled: true }, { id: 'off', kind: 'openai', label: 'Off', enabled: false }, { id: 'lm', kind: 'lmstudio', label: 'LM Studio', enabled: true }, { id: 'bad', kind: 'anthropic', label: 'Claude', enabled: true }];
      if (channel === 'limits:get') { if (args[0] === 'bad') throw new Error('refused'); return { windows: [{ label: '5-hour', usedPercent: 40 }] }; }
      return { daily: [{ date: '2026-11-06', input: 10, output: 5, cost: 0 }] };
    });
    const got = await readComputerUtilization('gomi', read as never);
    expect(got.providers.map((p) => p.id)).toEqual(['cg', 'bad']);
    expect(Object.keys(got.byToken)).toEqual(['cg']);
    expect([...got.answered]).toEqual(['cg', 'bad']);
    expect(got.usage?.daily[0].input).toBe(10);
    expect(calls).toContainEqual(['gomi', 'limits:get', 'cg']);
  });
  it("shows a watched computer's resident models without this computer's settings jumps", () => {
    resources.watched = 'gomi';
    try {
      const html = renderToStaticMarkup(<LocalModels initial={{ status: { running: true, installed: true, resident: [{ id: 'qwen', loadedOn: 'gpu', gpuLayers: 36, totalLayers: 36 }] } as any, models: [] }} />);
      expect(html).toContain('qwen');
      expect(html).toContain('on GPU · 36/36 layers');
      expect(html).not.toContain('data-local-model-settings');
      expect(html).not.toContain('Open Model Server');
      expect(renderToStaticMarkup(<LocalModels initial={{ status: { running: true, installed: false, resident: [] } as any, models: [] }} />)).toContain('No local engine installed.');
    } finally { resources.watched = null; }
  });
  it("swaps Utilization to the watched computer's, without this computer's providers or Manage providers", () => {
    resources.watched = 'gomi';
    try {
      const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, monitors: { automations: false, utilization: true, budget: false, hardware: false, localModels: false } } };
      const html = renderToStaticMarkup(<MonitorsDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[{ id: 'mine', kind: 'chatgpt', label: 'My ChatGPT', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'mine' }]} usage={null} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
      expect(html).toContain("Reading that computer&#x27;s providers…");
      expect(html).not.toContain('My ChatGPT');
      expect(html).not.toContain('Manage providers');
    } finally { resources.watched = null; }
  });
});

describe("a connected computer's Model Server from the dock", () => {
  it('offers Unload per model and the Model Server controls while watching a computer', () => {
    resources.watched = 'gomi';
    try {
      const html = renderToStaticMarkup(<LocalModels initial={{ status: { running: true, installed: true, resident: [{ id: 'qwen' }], settings: { maxLoaded: 2, idleTtlSeconds: 3600, jitLoad: false } } as any, models: [] }} />);
      expect(html).toContain('data-local-model-unload="qwen"');
      expect(html).toContain('data-computer-model-server');
      expect(html).toContain('Unload all');
      expect(html).toMatch(/<option value="3600" selected="">1 hour<\/option>/);
      expect(html).not.toContain('checked=""');
    } finally { resources.watched = null; }
  });
  it("shows the computer's choices but no way to change them while its server keeps its own", () => {
    const html = renderToStaticMarkup(<ComputerModelServer id="gomi" server={{ maxLoaded: 1, clientModelSettings: false }} resident={[]} change={vi.fn()} />);
    expect(html).toContain('keeps its own model settings');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain('Unload all');
  });
  it('shows no Model Server controls for this computer, which has its own page', () => {
    const html = renderToStaticMarkup(<LocalModels initial={{ status: { install: { binPath: '/x' }, running: true, resident: [], log: [], settings: { maxLoaded: 2 } } as any, models: [] }} />);
    expect(html).not.toContain('data-computer-model-server');
  });
});
