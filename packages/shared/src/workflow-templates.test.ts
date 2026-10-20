import { describe, expect, it } from 'vitest';
import { WORKFLOW_ACTIONS, WORKFLOW_TEMPLATES, templateLocalModel, templateReadiness, type TemplateEnvironment } from './workflows.js';

const ciTemplate = WORKFLOW_TEMPLATES.find((t) => t.id === 'diagnose-failed-ci')!;

const providers: TemplateEnvironment['providers'] = [
  { id: 'cloud', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', enabled: true },
  { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1', enabled: true },
  { id: 'lan', kind: 'ollama', baseUrl: 'http://10.0.0.5:11434', enabled: true },
  { id: 'off', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: false },
];

describe('Diagnose failed CI template', () => {
  it('reads the logs, diagnoses with no tools on a local model, and keeps one PR comment', () => {
    expect(ciTemplate).toMatchObject({ featured: true, category: 'Code review', localModelOnly: true, toolAccess: 'none' });
    const { steps, triggers } = ciTemplate.build({ repo: 'o/r' });
    expect(steps.map((s) => [s.id, s.kind, s.run.split('\n')[0]])).toEqual([
      ['logs', 'action', 'github.runFailureLogs'],
      ['diagnose', 'prompt', expect.stringContaining('GitHub Actions run failed')],
      ['comment', 'action', 'github.upsertPRComment'],
    ]);
    const [logs, diagnose, comment] = steps;
    expect(logs.onFailure).toEqual({ goto: 'fail' });
    expect(diagnose.tools).toBe('none');
    expect(diagnose.run).toContain('{{steps.logs.output}}');
    expect(diagnose.run).toContain('untrusted data');
    expect(diagnose.run).toContain('under 300 words');
    expect(comment.continueOnError).toBe(true);
    expect(comment.params?.number).toBe('{{trigger.number}}');
    expect(comment.params?.body).toMatch(/^### CI diagnosis for run \[\{\{trigger\.run_id\}\}\]\(\{\{trigger\.html_url\}\}\)/);
    expect(comment.params?.body).toContain('{{steps.diagnose.output}}');
    // Every action it uses is one the engine knows.
    for (const s of [logs, comment]) expect(WORKFLOW_ACTIONS.some((a) => a.op === s.run)).toBe(true);
    expect(triggers).toEqual([
      expect.objectContaining({ kind: 'connector', connector: 'github', event: 'workflow_run_failed', repo: 'o/r', pollIntervalMs: 120_000, enabled: true }),
    ]);
  });

  it('stays disarmed until a repo is set', () => {
    expect(ciTemplate.build({}).triggers[0]).toMatchObject({ repo: undefined, enabled: false });
  });

  it('needs GitHub and a local model, not a default one', () => {
    const env: TemplateEnvironment = { connectors: [{ kind: 'github', connected: true }], providers, defaultProviderId: 'cloud', defaultModelId: 'claude' };
    expect(templateReadiness(ciTemplate, env)).toEqual([
      { id: 'connector:github', label: 'GitHub connected', ok: true, fix: 'connectors' },
      { id: 'localModel', label: 'A local model', ok: false, fix: 'localModel' },
    ]);
    expect(templateReadiness(ciTemplate, { ...env, providerId: 'local', modelId: 'qwen' })[1].ok).toBe(true);
  });
});

describe('templateLocalModel', () => {
  const base: TemplateEnvironment = { connectors: [], providers };
  it('takes the chosen model only when it is local and enabled', () => {
    expect(templateLocalModel({ ...base, providerId: 'local', modelId: 'qwen' })).toEqual({ providerId: 'local', modelId: 'qwen' });
    expect(templateLocalModel({ ...base, providerId: 'lan', modelId: 'qwen' })).toBeUndefined();
    expect(templateLocalModel({ ...base, providerId: 'off', modelId: 'qwen' })).toBeUndefined();
  });
  it('falls back to a local default, never a cloud one', () => {
    expect(templateLocalModel({ ...base, defaultProviderId: 'local', defaultModelId: 'qwen' })).toEqual({ providerId: 'local', modelId: 'qwen' });
    expect(templateLocalModel({ ...base, defaultProviderId: 'cloud', defaultModelId: 'claude' })).toBeUndefined();
    // A chosen cloud model does not fall through to the local default.
    expect(templateLocalModel({ ...base, providerId: 'cloud', modelId: 'claude', defaultProviderId: 'local', defaultModelId: 'qwen' })).toBeUndefined();
  });
});
