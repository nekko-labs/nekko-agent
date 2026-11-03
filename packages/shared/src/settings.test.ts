import { describe, expect, it } from 'vitest';
import { DEFAULT_MONITORS_DOCK, DEFAULT_WALL_LAYOUT, keepSecrets, withoutSecrets, type CommandWallSetting } from './settings.js';

describe('command wall settings schema', () => {
  it('allows legacy settings without the new optional fields', () => {
    const legacy: CommandWallSetting = { root: null, autoAdd: true, filter: 'all', insights: { panels: {} }, watermark: 0 };
    expect(legacy.layout).toBeUndefined();
  });
  it('exports reusable layout and dock defaults', () => {
    expect(DEFAULT_WALL_LAYOUT).toEqual({ mode: 'grid', cols: 3, rows: 2, fixedGrid: false });
    expect(DEFAULT_MONITORS_DOCK.side).toBe('right');
    expect(DEFAULT_MONITORS_DOCK.show).toBe(true);
    expect(DEFAULT_MONITORS_DOCK.minimized).toEqual({
      automations: false, utilization: false, budget: false, insights: false, hardware: false, localModels: false,
    });
    expect(DEFAULT_MONITORS_DOCK.monitorOrder?.[0]).toBe('hardware');
    expect(DEFAULT_MONITORS_DOCK.monitorOrder?.[1]).toBe('localModels');
    expect(Object.keys(DEFAULT_MONITORS_DOCK.minimized)).toEqual(Object.keys(DEFAULT_MONITORS_DOCK.monitors));
    expect(Object.entries(DEFAULT_MONITORS_DOCK.monitors).filter(([, enabled]) => !enabled)).toEqual([['insights', false]]);
  });
});

describe('settings backups', () => {
  const settings = {
    theme: 'dark',
    hfToken: 'hf_x',
    providers: [{ id: 'p1', kind: 'openai', apiKey: 'sk-1' }, { id: 'p2', kind: 'ollama' }],
    connectors: [{ kind: 'github', connected: true, token: 'ghp_1' }],
    mcpServers: [{ id: 'm', name: 'M', command: '', args: [], enabled: true, url: 'http://x', token: 'mt' }],
    apiServer: { enabled: true, token: 'api' },
  };

  it('exports no key or token', () => {
    const backup = withoutSecrets(settings);
    expect(JSON.stringify(backup)).not.toMatch(/hf_x|sk-1|ghp_1|"mt"|"api"/);
    expect(backup.providers.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(settings.providers[0].apiKey).toBe('sk-1');
  });

  it('round-trips: importing a backup on the same computer keeps its keys', () => {
    const restored = keepSecrets(JSON.parse(JSON.stringify(withoutSecrets(settings))), settings);
    expect(restored).toEqual(settings);
  });

  it('keeps a key the backup itself carries, and gives none to a provider this computer lacks', () => {
    const imported = { providers: [{ id: 'p1', apiKey: 'sk-new' }, { id: 'p3' }] };
    expect(keepSecrets(imported, settings).providers).toEqual([{ id: 'p1', apiKey: 'sk-new' }, { id: 'p3' }]);
  });
});
