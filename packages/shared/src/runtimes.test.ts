import { describe, expect, it } from 'vitest';
import { RUNTIME_CAPABILITIES, isRuntimeKind, LOCAL_PROVIDER_KINDS } from './index.js';

describe('RUNTIME_CAPABILITIES', () => {
  it('never offers to start vLLM', () => {
    expect(RUNTIME_CAPABILITIES.vllm.canStart).toBe(false);
    expect(RUNTIME_CAPABILITIES.vllm.canLoad).toBe(false);
    expect(RUNTIME_CAPABILITIES.vllm.configuredAtLaunch).toBe(true);
  });

  it('marks Ollama parallelism as restart-required, not per-load', () => {
    expect(RUNTIME_CAPABILITIES.ollama.canSetParallel).toBe('server-env');
    expect(RUNTIME_CAPABILITIES.ollama.canSetKvCacheType).toBe('server-env');
  });

  it('only claims per-model VRAM where a runtime actually reports it', () => {
    expect(RUNTIME_CAPABILITIES.ollama.reportsPerModelVram).toBe(true);
    expect(RUNTIME_CAPABILITIES.lmstudio.reportsPerModelVram).toBe(false);
    expect(RUNTIME_CAPABILITIES.vllm.reportsPerModelVram).toBe(false);
  });

  it('covers exactly the local provider kinds', () => {
    expect(Object.keys(RUNTIME_CAPABILITIES).sort()).toEqual([...LOCAL_PROVIDER_KINDS].sort());
  });
});

describe('isRuntimeKind', () => {
  it('accepts the three local servers and rejects dual-use kinds', () => {
    expect(isRuntimeKind('ollama')).toBe(true);
    expect(isRuntimeKind('lmstudio')).toBe(true);
    expect(isRuntimeKind('vllm')).toBe(true);
    // openai-compat may be a localhost server or a remote gateway, so it is not
    // something we would ever start or stop on the user's behalf.
    expect(isRuntimeKind('openai-compat')).toBe(false);
    expect(isRuntimeKind('anthropic')).toBe(false);
  });
});
