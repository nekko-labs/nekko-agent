import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { View } from '../store.js';
import { AgentsBreadcrumb } from './AgentsBreadcrumb.js';

const state = vi.hoisted(() => ({ view: 'command' as View, settings: { language: 'en' }, setView: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));

beforeEach(() => { state.view = 'command'; state.settings.language = 'en'; state.setView.mockClear(); });

describe('Agents breadcrumb', () => {
  it('is absent on Agents', () => {
    expect(renderToStaticMarkup(<AgentsBreadcrumb />)).toBe('');
  });

  it.each([
    ['artifacts', 'Library'], ['skills', 'Skills'], ['training', 'Training'],
    ['workflows', 'Automations'], ['design', 'Design'], ['models', 'Models'],
    ['modelserver', 'Models'], ['connectors', 'Connectors'], ['memory', 'Memory'], ['settings', 'Settings'],
  ] as const)('provides a return control and current destination on %s', (view, label) => {
    state.view = view;
    const html = renderToStaticMarkup(<AgentsBreadcrumb />);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-back-to-agents');
    expect(html).toContain('Agents</button>');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(label + '</span>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('returns directly to Agents through the existing view action', () => {
    state.view = 'settings';
    const tree = AgentsBreadcrumb()!;
    tree.props.children[0].props.onClick();
    expect(state.setView).toHaveBeenCalledExactlyOnceWith('command');
  });

  it('uses the existing destination translations', () => {
    state.view = 'settings'; state.settings.language = 'ja';
    const html = renderToStaticMarkup(<AgentsBreadcrumb />);
    expect(html).toContain('エージェント');
    expect(html).toContain('設定');
  });
});
