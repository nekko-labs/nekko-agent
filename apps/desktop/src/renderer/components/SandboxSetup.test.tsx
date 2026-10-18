import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@nekko-agent/shared';
import { IpcChannels } from '@nekko-agent/shared';
import { Markdown, MarkdownSandbox } from './Markdown.js';

const store = vi.hoisted(() => ({ settings: { gitManagement: { mode: 'worktree' } } as Record<string, unknown>, refreshSettings: vi.fn(async () => {}), pushToast: vi.fn(), openFilePane: vi.fn(), sessions: [] as unknown[] }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store }) }));
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }));
import { SandboxReview, SandboxSetup, SANDBOX_APPLY_BLOCKER, isPinnedSandboxImage } from './SandboxSetup.js';
import { modePanelActions } from './ModePanel.js';
import { SpecPanel } from './SpecPanel.js';
import { ContextInspector } from './ContextInspector.js';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const chat = (patch: Partial<Session> = {}) => ({ id: 's', title: 'Chat', messages: [], createdAt: 0, updatedAt: 0, ...patch }) as Session;
const DIGEST = `local/sandbox@sha256:${'a'.repeat(64)}`;
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('sandbox renderer safety regressions', () => {
  it('requires a pinned local image and explicit setup consent, and never pulls', () => {
    expect(isPinnedSandboxImage(DIGEST)).toBe(true);
    for (const bad of ['local/sandbox:latest', 'local/sandbox@sha256:abc', `${DIGEST}x`, '']) expect(isPinnedSandboxImage(bad), bad).toBe(false);
    vi.stubGlobal('document', { activeElement: null, addEventListener() {}, removeEventListener() {}, body: {} });
    const html = renderToStaticMarkup(<SandboxSetup session={chat({ sandbox: undefined })} onChange={() => {}} onClose={() => {}} />);
    expect(html).toContain('No images will be pulled.');
    // Nothing typed and no consent yet: Configure is off.
    expect(html).toMatch(/<button class="ctl-menu" disabled="">Configure Sandbox<\/button>/);
    expect(html).toContain('type="checkbox"');
  });

  it('configures with fresh Ask permissions and saves Sandbox as the default', async () => {
    // configure() is a click handler; drive the same host calls through the panel's action contract.
    const nekko = { configureSandbox: vi.fn(async () => ({ phase: 'configured' })), setSessionOptions: vi.fn(async () => chat()), updateSettings: vi.fn(async () => ({})) };
    vi.stubGlobal('window', { nekko });
    // Source pin for the click handler's exact patch (no DOM library is installed to click it).
    const setup = source('./SandboxSetup.tsx');
    expect(setup).toMatch(/setSessionOptions\(session\.id, \{ executionMode: 'sandbox', mode: 'ask' \}\)/);
    expect(setup).toMatch(/updateSettings\(\{ defaultExecutionMode: 'sandbox' \}\)/);
    // Choosing Sandbox in the Mode panel opens setup instead of switching straight in.
    const onSandboxSetup = vi.fn();
    await modePanelActions({ session: chat(), isCloudModel: false, onChange: vi.fn(), onSandboxSetup }).setExecution('sandbox');
    expect(onSandboxSetup).toHaveBeenCalledOnce();
    expect(nekko.setSessionOptions).not.toHaveBeenCalled();
  });

  it('keeps execution and permissions separate and persists the execution default', async () => {
    const nekko = { setSessionOptions: vi.fn(async (_id: string, patch: Partial<Session>) => chat(patch)), updateSettings: vi.fn(async () => ({})) };
    vi.stubGlobal('window', { nekko });
    await modePanelActions({ session: chat({ mode: 'yolo' }), isCloudModel: false, onChange: vi.fn(), onSandboxSetup: vi.fn() }).setExecution('unified');
    // Where it runs changes; the chat's approvals are left alone.
    expect(nekko.setSessionOptions).toHaveBeenCalledWith('s', { executionMode: 'unified', gitIsolation: false });
    expect(nekko.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultExecutionMode: 'unified' }));
    // Source pin: the header's checkout chip switches through the same pair (its handler is a click).
    expect(source('./WorktreeChip.tsx')).toMatch(/setSessionOptions\(session\.id, \{ gitIsolation, executionMode \}\)/);
  });

  it('never offers a working apply-back action', () => {
    expect(SANDBOX_APPLY_BLOCKER).toMatch(/host API is fail-closed/);
    const review = renderToStaticMarkup(<SandboxReview sessionId="s" />);
    expect(review).toContain('Review sandbox diff');
    expect(review).not.toMatch(/apply/i);
    // Source pin: the review dialog opens on click and there is no apply call anywhere in it.
    const setup = source('./SandboxSetup.tsx');
    expect(setup).not.toMatch(/applySandboxDiff\(/);
    expect(setup).toContain('Sandbox diff (read-only)');
  });

  it('wires the exact shared sandbox channels in both transports', () => {
    // A transport-contract check: each side must name the shared channel constant.
    for (const file of ['../../preload/index.ts', '../web-client.ts']) {
      const transport = source(file);
      for (const channel of ['sandboxConfigure', 'sandboxStatus', 'sandboxDiff', 'sandboxApplyDiff'] as const) {
        expect(IpcChannels[channel], channel).toBeTruthy();
        expect(transport, `${file} ${channel}`).toContain(`IpcChannels.${channel}`);
      }
    }
  });

  it('blocks host panels before mounting their side effects', () => {
    store.sessions = [{ id: 's', executionMode: 'sandbox' }];
    try {
      expect(renderToStaticMarkup(<ContextInspector sessionId="s" />)).toContain('unavailable in Sandbox');
      expect(renderToStaticMarkup(<SpecPanel sessionId="s" session={chat({ executionMode: 'sandbox' })} />)).toContain('Host spec actions are unavailable in Sandbox.');
    } finally { store.sessions = []; }
    // Sending from a chat that is not configured fails closed (source pin: send() is a click handler).
    expect(source('./ChatPane.tsx')).toContain('Configure Sandbox before executing.');
  });

  it.each([false, true])('blocks Markdown host image reads and source actions in Sandbox (doc=%s)', (doc) => {
    const effects: Array<() => void | (() => void)> = [];
    const effect = vi.spyOn(React, 'useEffect').mockImplementation(callback => { effects.push(callback); });
    const readFile = vi.fn();
    vi.stubGlobal('window', { nekko: { readFile } });
    try {
      const out = renderToStaticMarkup(<MarkdownSandbox.Provider value>
        <Markdown doc={doc} basePath="/project" text="![SVG](a.svg) ![Raster](a.png)" />
      </MarkdownSandbox.Provider>);
      expect(effects).toHaveLength(2);
      effects.forEach(callback => callback());
      expect(readFile).not.toHaveBeenCalled();
      expect(out).not.toContain('<img');
      expect(out.match(/Host image previews are unavailable in Sandbox/g)).toHaveLength(2);
      expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    } finally { effect.mockRestore(); vi.unstubAllGlobals(); }
  });
});
