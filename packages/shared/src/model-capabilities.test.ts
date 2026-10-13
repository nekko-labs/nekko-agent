import { describe, expect, it } from 'vitest';
import { estimateTranscriptTokens, estimateTokens } from './context.js';
import {
  claudeContextWindow,
  claudeMaxOutputTokens,
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
  it('offers the five Anthropic rungs only where the model takes an effort level', () => {
    expect(modelEffortLevels('claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelEffortLevels('claude-fable-5-1')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelEffortLevels('claude-haiku-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelDefaultEffort('claude-haiku-5-5')).toBe('high');
    // 4.6 and Haiku 4.5 still sample, so they get the temperature scale.
    expect(usesNativeEffort('claude-sonnet-4-6')).toBe(false);
    expect(modelEffortLevels('claude-haiku-4-5')).toEqual(['low', 'normal', 'high']);
    expect(modelEffortLevels('gpt-5')).toEqual(['low', 'medium', 'normal', 'high']);
    expect(modelEffortLevels('openai/gpt-6-sol')).toEqual(['low', 'medium', 'normal', 'high']);
  });

  it('knows Opus 5.5 defaults to medium, not high', () => {
    expect(modelDefaultEffort('claude-opus-5-5')).toBe('medium');
    expect(modelDefaultEffort('claude-opus-5')).toBe('high');
    expect(effectiveEffort('normal', 'claude-opus-5-5')).toBe('medium');
    expect(effectiveEffort(undefined, 'claude-opus-5')).toBe('high');
  });

  it('maps a saved rung the model lacks to the nearest one it has', () => {
    expect(effectiveEffort('xhigh', 'gpt-5')).toBe('high');
    expect(effectiveEffort('medium', 'gpt-5')).toBe('medium');
    expect(effectiveEffort('medium', 'llama3')).toBe('normal');
    expect(effectiveEffort('xhigh', 'claude-opus-5')).toBe('xhigh');
  });
});

describe('claudeMaxOutputTokens', () => {
  it('reads the output ceiling off the family and generation', () => {
    expect(claudeMaxOutputTokens('claude-opus-5-5')).toBe(64_000);
    expect(claudeMaxOutputTokens('anthropic/claude-opus-4-1')).toBe(32_000);
    expect(claudeMaxOutputTokens('claude-opus-4-5')).toBe(64_000);
    expect(claudeMaxOutputTokens('claude-sonnet-4-6')).toBe(64_000);
    expect(claudeMaxOutputTokens('claude-3-5-sonnet')).toBe(32_000); // not the family-first id shape: unknown
    expect(claudeMaxOutputTokens('claude-sonnet-3-5')).toBe(8_192);
    expect(claudeMaxOutputTokens('claude-haiku-4-5-20251001')).toBe(64_000);
    expect(claudeMaxOutputTokens('claude-haiku-5-5')).toBe(128_000);
    expect(claudeMaxOutputTokens('claude-fable-5-1')).toBe(64_000);
  });
  it('gives an unrecognised id a generous middle value', () => {
    expect(claudeMaxOutputTokens('my-proxy-model')).toBe(32_000);
    expect(claudeMaxOutputTokens(undefined)).toBe(32_000);
  });
});
