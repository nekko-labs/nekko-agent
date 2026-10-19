import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerWebhookRoutes, type WebhookTarget } from './webhooks.js';

/** nekkod's `workflow:webhook` as the server sees it: one hook, `good-secret` starts it. */
let calls: Array<[string, string, Record<string, unknown>]> = [];
const target: WebhookTarget = {
  dispatchWebhook: async (slug, secret, payload) => {
    calls.push([slug, secret, payload]);
    if (slug === 'my-workflow' && secret !== 'good-secret') throw Object.assign(new Error('unauthorized'), { code: 'WEBHOOK_UNAUTHORIZED' });
    return { length: slug === 'my-workflow' ? 1 : 0 };
  },
};
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  calls = [];
  app = Fastify();
  registerWebhookRoutes(app, target);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/hooks/:slug', () => {
  it('rejects a missing key before asking the engine', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers a bad secret with 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow?key=bad-secret', payload: { foo: 1 } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('hands a valid call to the engine and reports the runs it started', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/hooks/my-workflow?key=good-secret', payload: { branch: 'main' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).started).toBe(1);
    expect(calls).toEqual([['my-workflow', 'good-secret', { branch: 'main', __raw: '{"branch":"main"}' }]]);
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
