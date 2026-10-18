import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createHost, setDataDir, type Host } from '@nekko-agent/host';
import { registerWebhookRoutes } from './webhooks.js';

let dir = '';
let host: Host;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'local-model-server-webhooks-'));
  setDataDir(dir);
  host = createHost({ dataDir: dir });
  app = Fastify();
  registerWebhookRoutes(app, host);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/hooks/:slug', () => {
  it('rejects a missing key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bad secret and does not start a workflow', async () => {
    const wf = await host.createWorkflow({
      name: 'My Workflow',
      steps: [{ id: 's1', name: 'Echo', kind: 'shell', run: 'echo ok' }],
      triggers: [{ id: 't1', kind: 'webhook', webhookSecret: 'good-secret' }],
    });
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow?key=bad-secret', payload: { foo: 1 } });
    expect(res.statusCode).toBe(403);
    expect(await host.listWorkflowRuns(wf.id)).toHaveLength(0);
  });

  it('dispatches a workflow with a valid secret', async () => {
    const wf = await host.createWorkflow({
      name: 'My Workflow',
      steps: [{ id: 's1', name: 'Echo', kind: 'shell', run: 'echo ok' }],
      triggers: [{ id: 't1', kind: 'webhook', webhookSecret: 'good-secret' }],
    });
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow?key=good-secret', payload: { branch: 'main' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).started).toBe(1);
    const runs = await host.listWorkflowRuns(wf.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerKind).toBe('webhook');
    expect(runs[0].triggerLabel).toContain('Webhook');
  });

  it('enforces the 10 MB body cap', async () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow?key=s', payload: { big } });
    expect(res.statusCode).toBe(413);
  });

  it('rate limits repeated calls', async () => {
    const res1 = await app.inject({ method: 'POST', url: '/api/hooks/rated?key=k', payload: {} });
    expect(res1.statusCode).toBe(200);
    let hit429 = false;
    for (let i = 0; i < 70; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/hooks/rated?key=k', payload: {} });
      if (res.statusCode === 429) {
        hit429 = true;
        break;
      }
    }
    expect(hit429).toBe(true);
  });
});
