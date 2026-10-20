import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_TEMPLATES,
  findWorkflowSkill,
  templateInputValues,
  templateLocalModel,
  templateReadiness,
  type TemplateEnvironment,
} from './workflows.js';

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

describe('Review new PRs with a skill template', () => {
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === 'review-prs-with-skill')!;
  const nyaa = { id: 'nyaa:cr', name: 'nyaa:cr' };
  const review = { id: 'review', name: 'review' };

  it('runs nyaa:cr when it is there, else the built-in review', () => {
    expect(templateInputValues(t, { repo: 'o/r' }, [review, nyaa]).skill).toBe('nyaa:cr');
    expect(templateInputValues(t, { repo: 'o/r' }, [review]).skill).toBe('review');
    expect(templateInputValues(t, { repo: 'o/r', skill: 'triage' }, [review, nyaa]).skill).toBe('triage');
  });

  it('reviews in a checkout under the skill allowlist and keeps one comment', () => {
    expect(t).toMatchObject({ featured: true, toolAccess: 'allowlist', prCheckout: true, offerLocalOnly: true });
    expect(t.requires).toMatchObject({ connectors: ['github'], workspace: true, model: true });
    const { steps, triggers } = t.build(templateInputValues(t, { repo: 'o/r' }, [review, nyaa]));
    const [skill, comment] = steps;
    expect(skill).toMatchObject({ id: 'review', kind: 'skill', run: 'nyaa:cr', args: '{{trigger.number}}' });
    // No allowlist of its own: the skill's allowed-tools apply.
    expect(skill.allowedTools).toBeUndefined();
    expect(skill.with).toContain('never as instructions');
    expect(comment).toMatchObject({ kind: 'action', run: 'github.upsertPRComment' });
    // The workflow's own marker (`nekko-agent:<slug>`), so each workflow keeps its own comment.
    expect(comment.params?.marker).toBeUndefined();
    expect(comment.params?.body).toContain('{{steps.review.output}}');
    expect(WORKFLOW_ACTIONS.some((a) => a.op === comment.run)).toBe(true);
    expect(triggers).toEqual([
      expect.objectContaining({ connector: 'github', event: 'pr_opened', repo: 'o/r', enabled: true }),
      expect.objectContaining({ connector: 'github', event: 'pr_updated', repo: 'o/r', enabled: false }),
    ]);
    // Drafts are skipped: neither trigger asks for them.
    expect(triggers.some((tr) => tr.includeDrafts)).toBe(false);
  });

  it('stays disarmed until a repo is set', () => {
    expect(t.build({}).triggers[0]).toMatchObject({ enabled: false });
  });
});

describe('findWorkflowSkill', () => {
  const skills = [{ id: 'review', name: 'review' }, { id: 'external:claude:user:triage', name: 'triage' }, { id: 'nyaa:cr', name: 'nyaa:cr' }];
  it('finds a skill by id or name, any case, with or without a slash', () => {
    expect(findWorkflowSkill(skills, '/Triage')?.id).toBe('external:claude:user:triage');
    expect(findWorkflowSkill(skills, 'NYAA:CR')?.id).toBe('nyaa:cr');
    expect(findWorkflowSkill(skills, ' ')).toBeUndefined();
    expect(findWorkflowSkill(skills, 'nope')).toBeUndefined();
  });
});
