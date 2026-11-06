import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWindowPicker, AgentWindowDropdown, windowDropdownPosition } from './AgentWindowPicker.js';
vi.mock('react-dom', () => ({ createPortal: vi.fn((node) => node) }));
import { ModelPicker } from './agent-console/ModelPicker.js';

const rememberModel = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  sessions: [{ id: 'chat-1', title: 'Active chat' }, { id: 'image-1', title: 'Pictures', chatType: 'image' }, { id: 'archived', title: 'Archived', archivedAt: 1 }],
  terminals: [{ id: 'term-1', title: 'Shell', cwd: '/project', running: true }, { id: 'term-2', title: 'Old shell', cwd: '/project', running: false }],
  providers: [{ id: 'p', enabled: true }, { id: 'disabled', enabled: false }],
  models: [{ id: 'm', providerId: 'p', name: 'Model' }],
  activeProviderId: 'p',
  activeModelId: null as string | null,
  activeProjectId: 'f2' as string | null,
  settings: { workspaces: [{ id: 'f1', name: 'one', path: '/one' }, { id: 'f2', name: 'two', path: '/two' }] } as Record<string, unknown> | null,
  computers: [] as Array<Record<string, unknown>>,
  computerCatalogs: {} as Record<string, { providers: Array<Record<string, unknown>>; workspaces: Array<Record<string, unknown>> }>,
}));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => ({ rememberModel, refreshSettings: vi.fn(async () => {}), pushToast: vi.fn() }) }) }));
vi.mock('./agent-console/ModelPicker.js', () => ({ ModelPicker: () => null }));
vi.mock('./ChatMetrics.js', () => ({ EffortSlider: () => null }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState), useRef: vi.fn(actual.useRef), useEffect: vi.fn(), useLayoutEffect: vi.fn(), useMemo: (fn: () => unknown) => fn() };
});
afterEach(() => vi.clearAllMocks());

/** The computer the next `picker()` runs on, and that computer's models. */
const runOn = { current: null as string | null, models: [] as Array<{ id: string; providerId: string; name: string }> };

function picker(category: 'chat' | 'media' | 'terminal' | null = null, choice: { providerId: string; modelId: string } | null = null, pending = false, error: string | null = null, onAdd = vi.fn(async () => {}), listOpen = false, folders: string[] | null = null) {
  const setters = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  [category, choice, pending, error, listOpen, folders, runOn.current, runOn.models].forEach((value, i) => vi.mocked(useState).mockReturnValueOnce([value, setters[i]] as never));
  vi.mocked(useRef).mockReturnValueOnce({ current: false }).mockReturnValueOnce({ current: null });
  const onClose = vi.fn();
  const tree = AgentWindowPicker({ onAdd, onClose });
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    elements.push(child);
    walk(child.props.children);
  });
  walk(tree);
  const text = (node: React.ReactNode): string => React.Children.toArray(node).map((child) => React.isValidElement<{ children?: React.ReactNode }>(child) ? text(child.props.children) : typeof child === 'string' ? child : '').join('');
  const button = (label: string) => elements.find((e) => e.type === 'button' && text(e.props.children).includes(label))!;
  return { elements, setters, onAdd, onClose, button };
}

describe('Run on', () => {
  const gomi = { id: 'gomi1234', name: 'gomi', state: 'online', change: true };
  afterEach(() => {
    state.computers = [];
    state.computerCatalogs = {};
    runOn.current = null;
    runOn.models = [];
  });

  it('is not there with nothing connected', () => {
    const { elements } = picker('chat');
    expect(elements.some((e) => e.props.role === 'radiogroup')).toBe(false);
  });

  it('offers this computer, and a connected one', () => {
    state.computers = [gomi, { ...gomi, id: 'off12345', name: 'studio', state: 'offline' }];
    const { button, elements } = picker('chat');
    expect(elements.some((e) => e.props.role === 'radiogroup')).toBe(true);
    expect(button('This computer').props['aria-checked']).toBe(true);
    expect(button('gomi').props.disabled).toBe(false);
    expect(button('studio').props.disabled).toBe(true);
  });

  it("shows that computer's folders, never this one's, and starts the chat there", async () => {
    state.computers = [gomi];
    state.computerCatalogs = { gomi1234: { providers: [{ id: '@gomi1234:p1', enabled: true, label: 'Model Server' }], workspaces: [{ id: '@gomi1234:w1', name: 'router', path: 'C:\\code\\router' }] } };
    runOn.current = 'gomi1234';
    runOn.models = [{ id: 'qwen', providerId: '@gomi1234:p1', name: 'Qwen' }];
    const onAdd = vi.fn(async () => {});
    const { button, elements } = picker('chat', { providerId: '@gomi1234:p1', modelId: 'qwen' }, false, null, onAdd);
    const folderNames = elements.filter((e) => e.props.role === 'checkbox').map((e) => e.props.title);
    expect(folderNames).toEqual(['C:\\code\\router']);
    button('Start').props.onClick();
    await Promise.resolve();
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ computerId: 'gomi1234', providerId: '@gomi1234:p1', workspaceIds: ['@gomi1234:w1'] }));
  });

  it('keeps Start off until that computer has a model', () => {
    state.computers = [gomi];
    state.computerCatalogs = { gomi1234: { providers: [], workspaces: [] } };
    runOn.current = 'gomi1234';
    expect(picker('chat').button('Start').props.disabled).toBe(true);
  });
});

describe('anchored window dropdown', () => {
  it('clamps to narrow and short viewports without reserving wall space', () => {
    expect(windowDropdownPosition({ left: 1200, bottom: 40 }, 1400, 900)).toEqual({ left: 752, top: 48, width: 640, maxHeight: 844 });
    expect(windowDropdownPosition({ left: 300, bottom: 450 }, 360, 500)).toEqual({ left: 8, top: 380, width: 344, maxHeight: 112 });
  });
  it('portals beside the anchor, ignores inside/trigger clicks, guards pending work and cleans up listeners', () => {
    const listeners = new Map<string, (event: any) => void>();
    const removeEventListener = vi.fn();
    const target = {}; const inside = {}; const trigger = {};
    let busy = false;
    const popup = { contains: (node: unknown) => node === inside, querySelector: () => busy ? {} : null };
    const anchor = { contains: (node: unknown) => node === trigger, getBoundingClientRect: () => ({ left: 100, bottom: 40 }) };
    const setPosition = vi.fn(); const onClose = vi.fn();
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, addEventListener: (name: string, fn: (e: any) => void) => listeners.set(name, fn), removeEventListener });
    vi.stubGlobal('document', { body: target });
    vi.mocked(useRef).mockReturnValueOnce({ current: popup });
    vi.mocked(useState).mockReturnValueOnce([null, setPosition] as never);
    try {
      AgentWindowDropdown({ anchorRef: { current: anchor } as any, onAdd: vi.fn(), onClose });
      const cleanPlacement = vi.mocked(useLayoutEffect).mock.calls.at(-1)![0]()!;
      const cleanDismissal = vi.mocked(useEffect).mock.calls.at(-1)![0]()!;
      expect(setPosition).toHaveBeenCalledWith({ left: 100, top: 48, width: 640, maxHeight: 744 });
      expect(vi.mocked(createPortal).mock.calls.at(-1)![1]).toBe(target);
      listeners.get('pointerdown')!({ target: inside });
      listeners.get('pointerdown')!({ target: trigger });
      busy = true;
      listeners.get('pointerdown')!({ target: {} });
      expect(onClose).not.toHaveBeenCalled();
      busy = false;
      listeners.get('pointerdown')!({ target: {} });
      listeners.get('keydown')!({ key: 'Escape', preventDefault: vi.fn(), defaultPrevented: false });
      expect(onClose).toHaveBeenCalledTimes(2);
      cleanPlacement(); cleanDismissal();
      expect(removeEventListener).toHaveBeenCalledTimes(4);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('AgentWindowPicker', () => {
  it('starts with three accessible category buttons and closes only on request', () => {
    const view = picker();
    for (const [label, category] of [['Chat', 'chat'], ['Media', 'media'], ['Terminal', 'terminal']]) {
      expect(view.button(label).props.type).toBe('button');
      view.button(label).props.onClick();
      expect(view.setters[0]).toHaveBeenCalledWith(category);
    }
    expect(view.elements.filter((e) => e.type === ModelPicker)).toHaveLength(0);
    expect(view.onAdd).not.toHaveBeenCalled();
    view.button('Close').props.onClick();
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it('dismisses with Escape and stops wall keyboard propagation', () => {
    const view = picker();
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    view.elements[0].props.onKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it('preselects the active model and project folder so Start is one click', async () => {
    const view = picker('chat');
    expect(view.elements.find((e) => e.type === ModelPicker)).toBeUndefined();
    expect(view.elements.find((e) => e.props['aria-controls'] === 'awp-model-list')!.props['aria-expanded']).toBe(false);
    expect(view.button('Change').props['aria-expanded']).toBe(false);
    expect(view.button('Start').props.disabled).toBe(false);
    await view.button('Start').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'multimodal', providerId: 'p', modelId: 'm', workspaceIds: ['f2'] });
  });

  it('prefers the saved default model over the active provider', async () => {
    state.settings = { ...state.settings, defaultProviderId: 'p', defaultModelId: 'saved' };
    try {
      const view = picker('chat');
      await view.button('Start').props.onClick();
      expect(view.onAdd).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p', modelId: 'saved' }));
    } finally {
      state.settings = { workspaces: (state.settings as { workspaces: unknown }).workspaces };
    }
  });

  it('shows the chosen model and closes the list once a model is picked', () => {
    const view = picker('chat', null, false, null, vi.fn(async () => {}), true);
    const modelPicker = view.elements.find((e) => e.type === ModelPicker)!;
    expect(modelPicker.props).toMatchObject({ expanded: true, open: true, readOnly: true, modelId: 'm', providers: [state.providers[0]] });
    modelPicker.props.onModel('p2', 'm2');
      expect(rememberModel).toHaveBeenCalledWith('p2', 'm2');
    expect(view.setters[1]).toHaveBeenCalledWith({ providerId: 'p2', modelId: 'm2' });
    expect(view.setters[4]).toHaveBeenCalledWith(false);
    expect(view.onAdd).not.toHaveBeenCalled();
  });

  it('creates a chat using the chosen model and folders without changing active store selection', async () => {
    const view = picker('chat', { providerId: 'p2', modelId: 'm2' }, false, null, vi.fn(async () => {}), true, ['f1', 'f2']);
    expect(view.elements.find((e) => e.type === ModelPicker)!.props.models).toEqual([]);
    await view.button('Start').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'multimodal', providerId: 'p2', modelId: 'm2', workspaceIds: ['f1', 'f2'] });
    expect(state.activeProviderId).toBe('p');
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it('toggles folders, keeping the first picked as primary', () => {
    const view = picker('chat', null, false, null, vi.fn(async () => {}), false, ['f2']);
    const one = view.elements.find((e) => e.props.role === 'checkbox' && e.props.title === '/one')!;
    expect(one.props['aria-checked']).toBe(false);
    one.props.onClick();
    expect(view.setters[5]).toHaveBeenCalledWith(['f2', 'f1']);
    view.elements.find((e) => e.props.role === 'checkbox' && e.props.title === '/two')!.props.onClick();
    expect(view.setters[5]).toHaveBeenLastCalledWith([]);
  });

  it('omits an empty provider id for Auto routing', async () => {
    const view = picker('chat', { providerId: '', modelId: 'auto' });
    await view.button('Start').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'multimodal', modelId: 'auto', workspaceIds: ['f2'] });
  });

  it('uses only a model belonging to the enabled active provider', async () => {
    const models = state.models;
    state.models = [{ id: 'foreign', providerId: 'disabled', name: 'Foreign' }, ...models];
    try {
      const view = picker('chat');
      await view.button('Start').props.onClick();
      expect(view.onAdd).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p', modelId: 'm' }));
      state.activeProviderId = 'disabled';
      expect(picker('chat').button('Start').props.disabled).toBe(true);
    } finally { state.models = models; state.activeProviderId = 'p'; }
  });

  it('passes an explicitly empty folder selection without restoring defaults', async () => {
    const view = picker('chat', null, false, null, vi.fn(async () => {}), false, []);
    await view.button('Start').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: [] }));
  });

  it('starts with the saved default folders, in order, ignoring folders that are gone', async () => {
    const saved = state.settings;
    state.settings = { ...saved, defaultWorkspaceIds: ['gone', 'f1', 'f2'] };
    try {
      const view = picker('chat');
      await view.button('Start').props.onClick();
      expect(view.onAdd).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: ['f1', 'f2'] }));
      expect(view.elements.some((e) => e.type === 'span' && e.props.className === 'agent-window-picker__default-note')).toBe(true);
      expect(view.button('Clear default')).toBeDefined();
    } finally { state.settings = saved; }
  });

  it('saves the checked folders as the default', async () => {
    const updateSettings = vi.fn(async () => ({}));
    vi.stubGlobal('window', { nekko: { updateSettings } });
    try {
      const view = picker('chat', null, false, null, vi.fn(async () => {}), false, ['f2', 'f1']);
      view.button('Set these 2 folders as default').props.onClick();
      expect(updateSettings).toHaveBeenCalledWith({ defaultWorkspaceIds: ['f2', 'f1'] });
      expect(picker('chat', null, false, null, vi.fn(async () => {}), false, ['f1']).button('Set this folder as default')).toBeDefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it('cannot start without any model available', () => {
    const models = state.models; const active = state.activeProviderId;
    state.models = []; state.activeProviderId = '';
    try { expect(picker('chat').button('Start').props.disabled).toBe(true); }
    finally { state.models = models; state.activeProviderId = active; }
  });

  it('excludes archived chats and preserves image type when opening', async () => {
    const view = picker('chat');
    expect(view.button('Archived')).toBeUndefined();
    await view.button('Pictures').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', refId: 'image-1', chatType: 'image' });
    await view.button('Active chat').props.onClick();
    expect(view.onAdd).toHaveBeenLastCalledWith({ kind: 'chat', refId: 'chat-1', chatType: 'multimodal' });
  });

  it('creates images but honestly disables planned video', async () => {
    const view = picker('media');
    expect(view.button('Video · Planned').props.disabled).toBe(true);
    expect(view.button('Video · Planned').props.onClick).toBeUndefined();
    await view.button('Create image session').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'image' });
  });

  it('supports new and existing terminals, including exited shells', async () => {
    const view = picker('terminal');
    await view.button('Create terminal').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'terminal' });
    await view.button('Old shell').props.onClick();
    expect(view.onAdd).toHaveBeenLastCalledWith({ kind: 'terminal', refId: 'term-2' });
  });

  it('guards double clicks while pending, exposes errors and permits retry', async () => {
    let reject!: (reason: Error) => void;
    const onAdd = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const view = picker('terminal', null, false, null, onAdd);
    view.button('Create terminal').props.onClick();
    view.button('Create terminal').props.onClick();
    expect(onAdd).toHaveBeenCalledOnce();
    reject(new Error('Permission denied'));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.setters[3]).toHaveBeenCalledWith('Permission denied');
    expect(view.setters[2]).toHaveBeenLastCalledWith(false);
    onAdd.mockResolvedValueOnce();
    view.button('Create terminal').props.onClick();
    expect(onAdd).toHaveBeenCalledTimes(2);
    const failed = picker('terminal', null, false, 'Permission denied');
    expect(failed.elements.find((e) => e.props.role === 'alert')!.props.children).toContain('Permission denied');
  });

  it('disables navigation and selections while adding and announces progress', () => {
    const view = picker('chat', null, true, null, vi.fn(async () => {}), true);
    expect(view.elements.filter((e) => e.type === 'button').every((e) => e.props.disabled)).toBe(true);
    expect(view.elements.find((e) => e.type === 'fieldset')!.props.disabled).toBe(true);
    expect(view.elements.some((e) => e.props.role === 'status')).toBe(true);
  });
});
