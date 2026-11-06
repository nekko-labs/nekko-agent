import { describe, expect, it } from 'vitest';
import { estimateTranscriptTokens, estimateTokens } from './context.js';
import {
  claudeContextWindow,
  effectiveEffort,
  guessContextWindow,
  modelDefaultEffort,
  modelEffortLevels,
  parseClaudeModel,
  usesNativeEffort,
} from './model-capabilities.js';

describe('transcript context estimate', () => {
  it('counts replayed tool traffic but not reasoning omitted by providers', () => {
    expect(estimateTranscriptTokens([
      { role: 'assistant', content: 'Working', reasoning: 'private'.repeat(100_000), toolCalls: [{ name: 'bash', input: { command: 'pwd' } }] },
      { role: 'tool', content: '', toolResult: { output: 'C:/code' } },
    ])).toBe(estimateTokens('Working\nbash\n{"command":"pwd"}\n\nC:/code'));
  });
});

describe('parseClaudeModel', () => {
  it('reads family and version, ignoring a vendor prefix and a date suffix', () => {
    expect(parseClaudeModel('anthropic/claude-opus-5-5')).toEqual({ family: 'opus', major: 5, minor: 5 });
    expect(parseClaudeModel('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', major: 4, minor: 5 });
    // A bare date is not a minor version.
    expect(parseClaudeModel('claude-opus-4-20250514')).toEqual({ family: 'opus', major: 4, minor: 0 });
    expect(parseClaudeModel('gpt-5')).toBeNull();
  });

  it('reads Bedrock ids, with or without an inference-profile prefix', () => {
    expect(parseClaudeModel('anthropic.claude-opus-5-5')).toEqual({ family: 'opus', major: 5, minor: 5 });
    expect(parseClaudeModel('us.anthropic.claude-haiku-4-5')).toEqual({ family: 'haiku', major: 4, minor: 5 });
    expect(parseClaudeModel('anthropic.titan-text')).toBeNull();
  });
});

describe('claudeContextWindow', () => {
  it('gives every current model 1M and Haiku 4.5 200k', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5-1', 'claude-haiku-5-5']) {
      expect(claudeContextWindow(id)).toBe(1_000_000);
    }
    expect(claudeContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(claudeContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(claudeContextWindow('llama3')).toBeUndefined();
  });
});

describe('Claude Code alias context guesses', () => {
  it('reads the bare aliases a Claude Agent chat runs on as 1M, and nothing else', () => {
    expect(guessContextWindow('opus')).toBe(1_000_000);
    expect(guessContextWindow('Sonnet')).toBe(1_000_000);
    expect(guessContextWindow('haiku')).toBe(1_000_000);
    expect(guessContextWindow('my-opus')).toBe(128_000);
  });
});

describe('GPT context guesses', () => {
  it('distinguishes published API windows from Codex subscription fallbacks', () => {
    expect(guessContextWindow('openai/gpt-5')).toBe(400_000);
    expect(guessContextWindow('gpt-5-mini')).toBe(400_000);
    expect(guessContextWindow('gpt-5-codex')).toBe(400_000);
    expect(guessContextWindow('gpt-4.1-mini')).toBe(1_047_576);
    expect(guessContextWindow('gpt-5.6-sol')).toBe(272_000);
    expect(guessContextWindow('gpt-6-sol')).toBe(128_000);
    expect(guessContextWindow('unknown')).toBe(128_000);
  });
});

describe('effort capability', () => {
  it('prefers API options, including future values, without a synthetic normal option', () => {
    const effort = { levels: [{ effort: 'medium' }, { effort: 'ultra', description: 'More reasoning' }, { effort: 'future-level' }], default: 'ultra' };
    expect(modelEffortLevels('unknown-model', effort)).toEqual(['medium', 'ultra', 'future-level']);
    expect(modelDefaultEffort('unknown-model', effort)).toBe('ultra');
    expect(effectiveEffort('normal', 'unknown-model', effort)).toBe('ultra');
    expect(effectiveEffort('future-level', 'unknown-model', effort)).toBe('future-level');
    expect(effectiveEffort('max', 'unknown-model', effort)).toBe('ultra');
    expect(modelEffortLevels('claude-opus-5', { levels: [] })).toEqual([]);
    expect(modelDefaultEffort('claude-opus-5', { levels: [] })).toBe('normal');
    expect(effectiveEffort('normal', 'claude-opus-5', { levels: [{ effort: 'high' }] })).toBe('normal');
  });
  it('resolves inherited or saved choices against the destination provider catalog', () => {
    const source = { levels: [{ effort: 'medium' }, { effort: 'ultra' }], default: 'medium' };
    const destination = { levels: [{ effort: 'medium' }, { effort: 'high' }], default: 'medium' };
    expect(effectiveEffort('ultra', 'gpt-5', source)).toBe('ultra');
    expect(effectiveEffort('ultra', 'gpt-5', destination)).toBe('medium');
    expect(effectiveEffort(undefined, 'gpt-5', destination)).toBe('medium');
    expect(effectiveEffort('ultra', 'claude-opus-5-5', { levels: [{ effort: 'high' }] })).toBe('normal');
    expect(effectiveEffort('ultra', 'claude-opus-5-5', { levels: [] })).toBe('normal');
    expect(effectiveEffort('ultra', 'gpt-5')).toBe('ultra');
  });
  it('does not invent effort choices when the API metadata is absent', () => {
    for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-haiku-4-5', 'gpt-5', 'openai/gpt-6-sol', 'llama3']) {
      expect(modelEffortLevels(id)).toEqual([]);
    }
    expect(modelDefaultEffort('claude-haiku-5-5')).toBe('high');
    expect(usesNativeEffort('claude-sonnet-4-6')).toBe(false);
  });

  it('knows Opus 5.5 defaults to medium, not high', () => {
    expect(modelDefaultEffort('claude-opus-5-5')).toBe('medium');
    expect(modelDefaultEffort('claude-opus-5')).toBe('high');
    expect(effectiveEffort('normal', 'claude-opus-5-5')).toBe('medium');
    expect(effectiveEffort(undefined, 'claude-opus-5')).toBe('high');
  });

  it('maps a saved rung the model lacks to the nearest one it has', () => {
    expect(effectiveEffort('xhigh', 'gpt-5')).toBe('xhigh');
    expect(effectiveEffort('medium', 'gpt-5')).toBe('medium');
    expect(effectiveEffort('medium', 'llama3')).toBe('normal');
    expect(effectiveEffort('xhigh', 'claude-opus-5')).toBe('xhigh');
  });
});
