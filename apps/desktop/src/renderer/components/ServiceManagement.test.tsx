import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServiceManagementView, phoneManagementPatch } from './ServiceManagement.js';
import type { UpdaterState } from './UpdateBanner.js';

const updater: UpdaterState = { app: null, info: null, stage: 'idle', error: null, check: vi.fn(), downloadOnly: vi.fn(), downloadAndInstall: vi.fn(), install: vi.fn(), skip: vi.fn(), retry: vi.fn(), dismissResult: vi.fn() };
const props = { status: { agentRunning: true, modelRunning: false, modelAvailable: false }, version: '1.2.3', confirming: false, confirmInstall: false,
  busy: false, error: '', notice: '', updater, manageFromPhone: false, onManageFromPhone: vi.fn(), onAsk: vi.fn(), onCancel: vi.fn(), onRestart: vi.fn(), onAskInstall: vi.fn(), onCancelInstall: vi.fn(), onInstall: vi.fn() };

describe('service management', () => {
  it('writes only the independent phone opt-in', () => {
    expect(phoneManagementPatch(true)).toEqual({ manageServiceFromPhone: true });
    expect(phoneManagementPatch(false)).toEqual({ manageServiceFromPhone: false });
    const tree = ServiceManagementView({ ...props, supported: true });
    const elements: React.ReactElement<Record<string, any>>[] = [];
    const walk = (node: React.ReactNode) => React.Children.forEach(node, child => { if (React.isValidElement<Record<string, any>>(child)) { elements.push(child); walk(child.props.children); } });
    walk(tree);
    elements.find(e => e.type === 'input')!.props.onChange({ target: { checked: true } });
    expect(props.onManageFromPhone).toHaveBeenCalledWith(true);
  });
  it('explains Local Web UI limitations and offers no restart or install action', () => {
    const html = renderToStaticMarkup(<ServiceManagementView {...props} supported={false} updater={{ ...updater, info: { state: 'downloaded', currentVersion: '1', version: '2', notesUrl: '', edition: 'web' } }} />);
    expect(html).toContain('not supported from the Local Web UI');
    expect(html).not.toContain('Restart service</button>');
    expect(html).not.toContain('Install update</button>');
  });
  it('allows local restart with phone opt-in off and requires confirmation', () => {
    const initial = renderToStaticMarkup(<ServiceManagementView {...props} supported status={null} />);
    expect(initial).toContain('Restart service');
    expect(initial).not.toContain('Confirm restart');
    expect(renderToStaticMarkup(<ServiceManagementView {...props} supported confirming />)).toContain('Your computer will not restart');
  });
  it('shows progress and errors and requires confirmation for install', () => {
    const info = { state: 'downloaded' as const, currentVersion: '1', version: '2', notesUrl: '', edition: 'desktop' as const };
    const initial = renderToStaticMarkup(<ServiceManagementView {...props} supported updater={{ ...updater, info }} />);
    expect(initial).toContain('Ready to install v2');
    expect(initial).not.toContain('Confirm install');
    expect(renderToStaticMarkup(<ServiceManagementView {...props} supported confirmInstall updater={{ ...updater, info }} />)).toContain('Confirm install');
    expect(renderToStaticMarkup(<ServiceManagementView {...props} supported updater={{ ...updater, stage: 'downloading', info: { ...info, state: 'downloading', percent: 42 } }} />)).toContain('42%');
    expect(renderToStaticMarkup(<ServiceManagementView {...props} supported updater={{ ...updater, stage: 'failed', error: 'Feed unavailable' }} />)).toContain('Feed unavailable');
    expect(renderToStaticMarkup(<ServiceManagementView {...props} supported updater={{ ...updater, stage: 'installing' }} />)).toContain('Install requested');
  });
});
