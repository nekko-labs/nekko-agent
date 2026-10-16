import { describe, expect, it } from 'vitest';
import { MODEL_FILTER_THRESHOLD, modelListProblem } from './modelListProblem.js';

const base = { connFailed: false, local: false, label: 'Ollama', baseUrl: 'http://localhost:11434' };

describe('modelListProblem', () => {
  it('shows the provider error', () => {
    expect(modelListProblem({ ...base, error: 'listModels 401: bad key' })).toBe("Couldn't list models: listModels 401: bad key");
  });

  it('does not repeat an error the failed connection test already shows', () => {
    expect(modelListProblem({ ...base, connFailed: true, error: 'listModels 401: bad key' })).toBe("Couldn't list models.");
  });

  it('says a local server that failed its test did not answer, over a raw fetch error', () => {
    expect(modelListProblem({ ...base, local: true, connFailed: true })).toBe("Ollama didn't answer at http://localhost:11434. Is it running?");
    expect(modelListProblem({ ...base, local: true, connFailed: true, error: 'fetch failed' })).toBe("Ollama didn't answer at http://localhost:11434. Is it running?");
  });

  it('has nothing to say about a working, empty list', () => {
    expect(modelListProblem(base)).toBeNull();
    expect(modelListProblem({ ...base, local: true })).toBeNull();
  });

  it('filters past the model picker threshold', () => {
    expect(MODEL_FILTER_THRESHOLD).toBe(8);
  });
});
