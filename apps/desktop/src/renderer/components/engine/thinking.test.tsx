import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LoadParams, LocalModel } from '@nekko-agent/shared';
import { ExpertControls } from './EngineLoadDrawer.js';

const expert = (params: LoadParams = {}, format: LocalModel['format'] = 'gguf') => renderToStaticMarkup(
  <ExpertControls model={{ id: 'local', format } as LocalModel} params={params} runOn="gpu" unified
    onChange={vi.fn()} onChangePlacement={vi.fn()} />,
);

function thinkingSwitch(html: string) {
  return html.match(/<button[^>]*aria-label="Thinking"[^>]*>/)?.[0];
}

describe('thinking controls', () => {
  it('offers default-on thinking only in local model Expert controls', () => {
    expect(thinkingSwitch(expert())).toContain('aria-checked="true"');
    expect(thinkingSwitch(expert({ thinking: false }))).toContain('aria-checked="false"');
    expect(thinkingSwitch(expert({ thinking: true }))).toContain('aria-checked="true"');
  });

  it('does not offer an unsupported MLX override', () => {
    expect(thinkingSwitch(expert({}, 'mlx'))).toBeUndefined();
  });

  it('keeps the composer passive and never writes the legacy chat preference', () => {
    const composer = readFileSync(new URL('../ChatPane.tsx', import.meta.url), 'utf8');
    expect(composer).not.toContain('session?.thinking');
    expect(composer).not.toContain('setThinkingPref');
    expect(composer).not.toContain('Thinking ${');
    expect(composer).toContain('The model streamed reasoning while writing this reply');
  });
});
