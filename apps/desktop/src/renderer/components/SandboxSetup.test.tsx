import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, MarkdownSandbox } from './Markdown.js';
import { readFileSync } from 'node:fs';

vi.mock('../store.js', () => ({ useStore: { getState: () => ({ openFilePane: vi.fn() }) } }));

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
describe('sandbox renderer safety regressions', () => {
  it('requires pinned local image and explicit setup consent', () => {
    const setup = source('./SandboxSetup.tsx');
    expect(setup).toContain('@sha256:[a-f0-9]{64}$');
    expect(setup).toContain('!consent || !isPinnedSandboxImage(image)');
    expect(setup).toContain("executionMode: 'sandbox', mode: 'ask'");
    expect(setup).toContain('No images will be pulled.');
  });
  it('never offers a working apply-back action', () => {
    const setup = source('./SandboxSetup.tsx');
    expect(setup).toContain('host API is fail-closed');
    expect(setup).not.toContain('applySandboxDiff(');
    expect(setup).toContain('Sandbox diff (read-only)');
  });
  it('keeps execution and permissions separate and persists the default', () => {
    const controls = source('./ChatControls.tsx');
    // Execution, Permissions and Work mode each get their own column.
    expect(controls).toContain('sm:grid-cols-3');
    expect(controls).toContain('aria-label="Work mode"');
    expect(controls).toContain('getExecutionMode(session)');
    expect(controls).toContain('defaultExecutionMode: executionMode');
    expect(controls).toContain('(recommended)');
    expect(source('./WorktreeChip.tsx')).toContain('{ gitIsolation, executionMode }');
  });
  it('wires the exact shared sandbox channels in both transports', () => {
    for (const file of ['../../preload/index.ts', '../web-client.ts']) {
      const transport = source(file);
      for (const channel of ['sandboxConfigure', 'sandboxStatus', 'sandboxDiff', 'sandboxApplyDiff']) expect(transport).toContain(`IpcChannels.${channel}`);
    }
  });
  it('blocks host panels before mounting their side effects', () => {
    expect(source('./ContextInspector.tsx')).toContain('HostContextInspector');
    expect(source('./SpecPanel.tsx')).toContain('HostSpecPanel');
    expect(source('./FilePane.tsx')).toContain('HostFilePane');
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
