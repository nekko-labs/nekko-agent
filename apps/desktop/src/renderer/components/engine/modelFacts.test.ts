import { describe, expect, it } from 'vitest';
import { contextFitText, familyProblem, memorySplit, modelProblem, paramsLabel, paramsText, sizeRangeText } from './modelFacts.js';

const GB = 1024 ** 3;

describe('parameters', () => {
  it('reads the count from a model name, with the active share of a mixture of experts', () => {
    expect(paramsText('Qwen3.8 27B')).toBe('27B');
    expect(paramsText('Qwen3.6 35B A3B')).toBe('35B, 3B active');
    expect(paramsText('gpt-oss 120B')).toBe('120B');
    expect(paramsText('EmbeddingGemma 300M')).toBe('300M');
    expect(paramsText('Qwen3.5 0.8B')).toBe('0.8B');
    expect(paramsText('Gemma 4 E4B')).toBe('4B effective');
    expect(paramsText('Gemma-4-31B-QAT')).toBe('31B');
  });

  it('falls back to what the file header says, and says nothing when neither does', () => {
    expect(paramsText('Ckpt_Q38', '1.4B')).toBe('1.4B');
    expect(paramsText('Qwen3 Coder Next')).toBeNull();
    expect(paramsText('Qwen3.5')).toBeNull();
  });

  it('labels the count for a row', () => {
    expect(paramsLabel('Qwen3.8 27B')).toBe('27B parameters');
    expect(paramsLabel('Qwen3 Coder 30B A3B')).toBe('30B parameters, 3B active');
    expect(paramsLabel('Gemma 4 E4B')).toBe('4B effective parameters');
  });
});

describe('a model with a problem wears it', () => {
  it('puts a failed load first, with its reason', () => {
    const p = modelProblem({ name: 'Ckpt_Q38', lastLoadError: 'a tensor is missing' });
    expect(p).toEqual({ text: 'Last load failed', tone: 'danger', detail: 'a tensor is missing' });
    expect(modelProblem({ name: 'Ckpt_Q38', lastLoadError: 'old', loaded: true })).toBeNull();
  });

  it('flags a vision model without its projector, and nothing on a healthy file', () => {
    expect(modelProblem({ name: 'Gemma 4', modality: 'vision', hasProjector: false })?.text).toBe('No projector');
    expect(modelProblem({ name: 'Gemma 4', modality: 'vision', hasProjector: true })).toBeNull();
    expect(modelProblem({ name: 'Qwen3 8B', modality: 'chat' })).toBeNull();
  });

  it('picks the worst problem across a family', () => {
    expect(familyProblem([{ name: 'a', modality: 'vision', hasProjector: false }, { name: 'b', lastLoadError: 'bad file' }])?.text).toBe('Last load failed');
    expect(familyProblem([{ name: 'a' }, { name: 'b' }])).toBeNull();
  });
});

describe('context and memory', () => {
  it('says how much context the rest of the memory buys', () => {
    expect(contextFitText(90112, 262144, 'this GPU')).toBe('Up to 88k fits in this GPU · 256k max');
    expect(contextFitText(262144, 262144, 'this GPU')).toBe('All of it fits in this GPU · 256k max');
    expect(contextFitText(0, 32768, 'this GPU')).toBe('No room for context in this GPU · 32k max');
    expect(contextFitText(undefined, 32768, 'this GPU')).toBe('32k max');
    expect(contextFitText(undefined, null, 'this GPU')).toBeNull();
  });

  it('splits a memory figure into weights and the rest, as shares of the budget', () => {
    expect(memorySplit(20 * GB, 16 * GB, 40 * GB)).toEqual({ weights: 0.4, rest: 0.09999999999999998 });
    expect(memorySplit(50 * GB, 45 * GB, 40 * GB)).toEqual({ weights: 1, rest: 0 });
  });

  it('gives a size range across quants', () => {
    expect(sizeRangeText([12.1 * GB, 21 * GB, 0])).toBe('12.1 GB to 21.0 GB');
    expect(sizeRangeText([5 * GB])).toBe('5.0 GB');
    expect(sizeRangeText([])).toBeNull();
  });
});
