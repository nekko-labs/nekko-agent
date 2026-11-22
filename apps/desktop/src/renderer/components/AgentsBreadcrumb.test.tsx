import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { View } from '../store.js';
import { AgentsBreadcrumb } from './AgentsBreadcrumb.js';

const state = vi.hoisted(() => ({ view: 'settings' as View, settings: { language: 'en' }, setView: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));

beforeEach(() => { state.view = 'settings'; state.settings.language = 'en'; state.setView.mockClear(); });

describe('Settings Agents breadcrumb', () => {
  it.each(['command', 'artifacts', 'skills', 'training', 'workflows', 'design', 'models', 'modelserver', 'connectors', 'memory'] as const)('is absent on %s', (view) => {
    state.view = view;
    expect(renderToStaticMarkup(<AgentsBreadcrumb />)).toBe('');
  });

  it('provides one return control and the Settings destination', () => {
    const html = renderToStaticMarkup(<AgentsBreadcrumb />);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-back-to-agents');
    expect(html).toContain('Agents</button>');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Settings</span>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('returns directly to Agents through the existing view action', () => {
    const tree = AgentsBreadcrumb()!;
    tree.props.children[0].props.onClick();
    expect(state.setView).toHaveBeenCalledExactlyOnceWith('command');
  });

  it('uses existing translations', () => {
    state.settings.language = 'ja';
    const html = renderToStaticMarkup(<AgentsBreadcrumb />);
    expect(html).toContain('エージェント');
    expect(html).toContain('設定');
  });
});
