import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EngineInstall, EngineOption } from '@nekko-agent/shared';

vi.mock('../../store.js', () => ({ useStore: (select: (s: { pushToast: () => void }) => unknown) => select({ pushToast: () => undefined }) }));
import { EngineGroups } from './Engines.js';
import { engineGroups, engineInUse, prefersMlx } from './engineRows.js';

const option = (id: EngineOption['id'], name: string, more: Partial<EngineOption> = {}): EngineOption => ({ id, name, detail: `${name} detail`, state: 'usable', ...more });
const off = (id: EngineOption['id'], name: string, reason: string, state: EngineOption['state'] = 'unsupported') => option(id, name, { state, reason });

/** An Apple Silicon Mac with MLX and llama.cpp installed, as the daemon lists it. */
const mac: EngineOption[] = [
  option('mlx', 'MLX', { labels: ['fastest', 'stable'], runtime: 'mlx', installed: true, version: 'mlx-lm 0.31.3', source: 'managed', inUse: true }),
  option('llama', 'llama.cpp', { runtime: 'llama', installed: true, version: 'b12532', source: 'managed' }),
  off('omlx', 'oMLX', 'Not in this version of Nekko yet', 'planned'),
  off('basalt', 'Basalt', 'NVIDIA RTX 50 series only'),
  off('squid5090', 'squid5090', 'NVIDIA RTX 5090 only'),
];
const build = { id: 'macos-arm64-metal', platform: 'darwin', arch: 'arm64', backend: 'metal', assetPattern: 'x', requires: 'An Apple Silicon Mac.' } as const;
const image = (more: Partial<EngineInstall> = {}): EngineInstall => ({ available: [build], ...more });
const chat = (engines: EngineOption[]) => engineGroups({ engines })[0].rows;
const render = (engines: EngineOption[], diffusionInstall?: EngineInstall) =>
  renderToStaticMarkup(<EngineGroups groups={engineGroups({ engines, diffusionInstall })} onChanged={() => undefined} />);

describe('the Engines block', () => {
  it('lists every engine, the ones this machine cannot run last, with the reason in place of the description', () => {
    const rows = chat(mac);
    expect(rows.map((r) => r.id)).toEqual(['mlx', 'llama', 'omlx', 'basalt', 'squid5090']);
    expect(rows.filter((r) => r.disabled).map((r) => r.detail)).toEqual(['Not in this version of Nekko yet', 'NVIDIA RTX 50 series only', 'NVIDIA RTX 5090 only']);
    // Nothing to do on a row that cannot be picked.
    expect(rows.filter((r) => r.disabled).every((r) => r.action === null && !r.removable && !r.runtime)).toBe(true);
  });

  it('marks the fastest and the most stable, and offers Use on the installed engines that are not in use', () => {
    const [mlx, llama] = chat(mac);
    expect(mlx).toMatchObject({ labels: ['Fastest', 'Most stable'], inUse: true, action: null, removable: true, meta: 'mlx-lm 0.31.3' });
    expect(llama).toMatchObject({ labels: [], inUse: false, action: 'use', removable: true, meta: 'b12532' });
  });

  it('puts the one primary Install on the fastest engine this machine can run and does not have', () => {
    const rows = chat([
      option('mlx', 'MLX', { labels: ['fastest', 'stable'], runtime: 'mlx' }),
      option('llama', 'llama.cpp', { runtime: 'llama', installed: true, source: 'managed', inUse: true }),
    ]);
    expect(rows.map((r) => [r.action, r.primary])).toEqual([['install', true], [null, false]]);
    // An engine slower than the one in use is still installable, quietly.
    const slower = chat([
      option('mlx', 'MLX', { runtime: 'mlx', installed: true, source: 'managed', inUse: true }),
      option('llama', 'llama.cpp', { runtime: 'llama' }),
    ]);
    expect(slower.map((r) => [r.action, r.primary])).toEqual([[null, false], ['install', false]]);
    // Nothing installed: the first installable row is the one to get.
    const none = chat([option('mlx', 'MLX', { runtime: 'mlx' }), option('llama', 'llama.cpp', { runtime: 'llama' })]);
    expect(none.map((r) => r.primary)).toEqual([true, false]);
  });

  it("never removes an engine that is the person's own install", () => {
    const [llama] = chat([option('llama', 'llama.cpp', { runtime: 'llama', installed: true, version: 'b12000', source: 'external', inUse: true })]);
    expect(llama).toMatchObject({ removable: false, meta: 'b12000 · your own install' });
  });

  it('gives image models their own group, hidden on a machine with no build for it', () => {
    expect(engineGroups({ engines: mac }).map((g) => g.id)).toEqual(['chat']);
    expect(engineGroups({ engines: mac, diffusionInstall: { available: [] } }).map((g) => g.id)).toEqual(['chat']);
    const groups = engineGroups({ engines: mac, diffusionInstall: image({ binPath: '/e/sd-server', version: 'master-1086', source: 'managed' }) });
    expect(groups.map((g) => g.title)).toEqual(['Chat models', 'Photo and video models']);
    expect(groups[1].rows[0]).toMatchObject({ id: 'diffusion', inUse: true, action: null, removable: true, meta: 'master-1086' });
    expect(engineGroups({ engines: mac, diffusionInstall: image() })[1].rows[0]).toMatchObject({ inUse: false, action: 'install' });
  });

  it('names the engine in use, and whether finding a model should start on MLX', () => {
    expect(engineInUse({ engines: mac })?.name).toBe('MLX');
    expect(prefersMlx({ engines: mac })).toBe(true);
    expect(prefersMlx({ engines: [option('llama', 'llama.cpp', { inUse: true })] })).toBe(false);
    expect(engineInUse({})).toBeUndefined();
    expect(engineGroups(null)).toEqual([]);
  });

  it('renders the rows as the design has them', () => {
    const html = render(mac, image({ binPath: '/e/sd-server', version: 'master-1086', source: 'managed' }));
    expect(html).toContain('Chat models');
    expect(html).toContain('Photo and video models');
    expect(html).toContain('Fastest');
    expect(html).toContain('Most stable');
    expect(html.match(/In use/g)).toHaveLength(2);
    expect(html).toContain('NVIDIA RTX 5090 only');
    expect(html).toContain('data-engine="squid5090" data-engine-state="disabled"');
    expect(html).toContain('data-engine="mlx" data-engine-state="in-use"');
    // A row that cannot be picked is marked so, takes no wash, and has no button.
    const squid = html.slice(html.indexOf('data-engine="squid5090"') - 200, html.indexOf('data-engine="squid5090"') + 600).split('</li>')[0];
    expect(html).toMatch(/aria-disabled="true"[^>]*data-engine="squid5090"/);
    expect(squid).not.toContain('<button');
    // The engine in use offers no Use; the other installed one does.
    expect(html.match(/>Use<\/button>/g)).toHaveLength(1);
    expect(html.match(/>Uninstall<\/button>/g)).toHaveLength(3);
  });

  it('says it is checking until the first status arrives', () => {
    expect(renderToStaticMarkup(<EngineGroups groups={[]} loading onChanged={() => undefined} />)).toContain('Checking engines…');
  });
});
