import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatCodeModeSavings, type CodeModeSavings } from '@nekko-agent/shared';
import { CodeModeTotal } from './UsageLimitsChip.js';

const saved = (tokensSaved: number): CodeModeSavings => ({
  toolsWrapped: 20, schemaTokensPerCall: 3000, schemaTokensSaved: tokensSaved, resultTokensSaved: 0,
  searchTokens: 0, tokensSaved, runs: 1, toolCalls: 2,
});

describe('code mode savings over a chat', () => {
  it('sums every code-mode reply, net of the ones that cost more', () => {
    const messages = [
      { turnStats: { codeMode: saved(12_000) } },
      {},
      { turnStats: {} },
      { turnStats: { codeMode: saved(-500) } },
    ] as never;
    expect(chatCodeModeSavings(messages)).toEqual({ tokensSaved: 11_500, replies: 2 });
    expect(chatCodeModeSavings([{}] as never)).toBeNull();
    expect(chatCodeModeSavings(undefined)).toBeNull();
  });

  it('shows the total in the usage popover, and says so when code mode came out behind', () => {
    const ahead = renderToStaticMarkup(<CodeModeTotal savings={{ tokensSaved: 11_500, replies: 2 }} />);
    expect(ahead).toContain('Saved by code mode · this chat');
    expect(ahead).toContain('≈12k tokens');
    expect(ahead).toContain('2 replies');
    const behind = renderToStaticMarkup(<CodeModeTotal savings={{ tokensSaved: -800, replies: 1 }} />);
    expect(behind).toContain('Code mode cost · this chat');
    expect(behind).toContain('≈800 tokens');
    expect(behind).toContain('More than a tool list would have.');
  });
});
