import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createHost, createDispatcher, withDataDir, type Host } from '@nekko-agent/host';
import { IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { CloudStore, publicAccount, type Account } from './accounts.js';
import { entitlements, requireWithin } from './entitlements.js';
import { createBilling, planChangeFromEvent, type Billing, type PaidPlan } from './billing.js';

export interface CloudServerOptions {
  /** Root for cloud metadata + per-account data dirs. */
  dataRoot: string;
  /** Built renderer dir to serve (same UI as desktop/web). Optional for tests. */
  rendererDir?: string;
  /** Billing integration; defaults to one built from env (disabled with no keys). */
  billing?: Billing;
}

/**
 * Nekko Cloud server. Fronts the SAME host engine + dispatcher as every other
 * edition, but per authenticated account: each account gets an isolated data
 * dir (its own settings/sessions/memory) via `withDataDir`, and feature limits
 * are enforced server-side from the account's plan. The OSS app never does any
 * of this, it just runs locally.
 */
export function createCloudServer(opts: CloudServerOptions): { app: FastifyInstance; store: CloudStore } {
  const store = new CloudStore(opts.dataRoot);
  const billing = opts.billing ?? createBilling();
  const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });

  // One Host per account, created lazily inside the account's data scope so its
  // event emitter (and any future per-account state) stays isolated.
  const hosts = new Map<string, Host>();
  const hostFor = (account: Account): Host => {
    let host = hosts.get(account.id);
    if (!host) {
      const dir = store.dataDirFor(account.id);
      host = withDataDir(dir, () => createHost({ dataDir: dir }));
      hosts.set(account.id, host);
    }
    return host;
  };

  const bearer = (req: FastifyRequest): string | undefined => {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return (req.query as Record<string, string> | undefined)?.token;
  };

  // Channels gated by plan limits before they run (count-based).
  const gate = (host: Host, account: Account, channel: string): void => {
    if (channel === IpcChannels.workspaceAddByPath) {
      requireWithin(account.plan, 'maxWorkspaces', host.listWorkspaces().length);
    }
  };

  app.register(async (api) => {
    await api.register(websocket);

    // --- Auth (unauthenticated) ---
    api.get('/api/auth/config', async () => ({ cloud: true, billing: billing.enabled }));

    api.post<{ Body: { email?: string; password?: string } }>('/api/auth/signup', async (req, reply) => {
      try {
        const { email = '', password = '' } = req.body ?? {};
        store.signup(email, password);
        const { token, account } = store.login(email, password);
        reply.send({ token, account: publicAccount(account), entitlements: entitlements(account.plan) });
      } catch (e) {
        reply.code(400).send({ error: (e as Error).message });
      }
    });

    api.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
      try {
        const { email = '', password = '' } = req.body ?? {};
        const { token, account } = store.login(email, password);
        reply.send({ token, account: publicAccount(account), entitlements: entitlements(account.plan) });
      } catch (e) {
        reply.code(401).send({ error: (e as Error).message });
      }
    });

    api.post('/api/auth/logout', async (req, reply) => {
      store.logout(bearer(req));
      reply.send({ ok: true });
    });

    api.get('/api/auth/me', async (req, reply) => {
      const account = store.verifyToken(bearer(req));
      if (!account) return reply.code(401).send({ error: 'unauthorized' });
      reply.send({ account: publicAccount(account), entitlements: entitlements(account.plan) });
    });

    // --- Relay (managed passthrough) ---
    // A gated relay (NEKKO_RELAY_AUTHZ_URL pointing here) asks whether the
    // agent presenting this bearer token may enroll. Any authenticated account
    // qualifies today (managed relay is free during beta); the reply carries the
    // plan's device allowance so limits can be surfaced/enforced downstream.
    api.post('/api/relay/authorize', async (req, reply) => {
      const account = store.verifyToken(bearer(req));
      if (!account) return reply.code(401).send({ ok: false, error: 'unauthorized' });
      reply.send({ ok: true, plan: account.plan, maxDevices: entitlements(account.plan).maxDevices });
    });

    // --- Billing (Stripe) ---
    // Start a Checkout Session for a paid plan; returns the URL to redirect to.
    api.post<{ Body: { plan?: string } }>('/api/billing/checkout', async (req, reply) => {
      const account = store.verifyToken(bearer(req));
      if (!account) return reply.code(401).send({ error: 'unauthorized' });
      const plan = req.body?.plan as PaidPlan | undefined;
      if (plan !== 'pro' && plan !== 'team') return reply.code(400).send({ error: 'Unknown plan.' });
      try {
        const result = await billing.createCheckout({
          accountId: account.id,
          email: account.email,
          plan,
          customerId: account.stripeCustomerId,
        });
        reply.send(result);
      } catch (e) {
        reply.code(400).send({ error: (e as Error).message });
      }
    });

    // Open the Stripe Customer Portal so the user can manage/cancel.
    api.post('/api/billing/portal', async (req, reply) => {
      const account = store.verifyToken(bearer(req));
      if (!account) return reply.code(401).send({ error: 'unauthorized' });
      if (!account.stripeCustomerId) return reply.code(400).send({ error: 'No billing customer for this account yet.' });
      try {
        reply.send(await billing.createPortal(account.stripeCustomerId));
      } catch (e) {
        reply.code(400).send({ error: (e as Error).message });
      }
    });

    const OAUTH_UNSUPPORTED = new Set<string>([IpcChannels.oauthBegin, IpcChannels.oauthFinish, IpcChannels.oauthCancel, IpcChannels.oauthSignOut, IpcChannels.providersImportCliAuth]);
    const OAUTH_UNSUPPORTED_MESSAGE = 'OAuth sign-in is only available in the desktop app.';

    // --- Authenticated NekkoApi (per-account host, isolated data dir) ---
    api.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>(
      '/api/:channel',
      async (req, reply) => {
        const account = store.verifyToken(bearer(req));
        if (!account) return reply.code(401).send({ error: 'unauthorized' });
        const channel = req.params.channel;
        if (OAUTH_UNSUPPORTED.has(channel)) {
          return reply.code(400).send({ error: OAUTH_UNSUPPORTED_MESSAGE });
        }
        if (channel === IpcChannels.oauthStatus) {
          const [providerConfigId] = req.body?.args ?? [];
          return reply.send({
            tokenKey: (providerConfigId as string) ?? '',
            connected: false,
            state: 'missing',
            message: OAUTH_UNSUPPORTED_MESSAGE,
          });
        }
        const host = hostFor(account);
        const dir = store.dataDirFor(account.id);
        try {
          const result = await withDataDir(dir, () => {
            gate(host, account, channel);
            return createDispatcher(host)(channel, req.body?.args ?? []);
          });
          reply.send(result ?? null);
        } catch (e) {
          reply.code(400).send({ error: (e as Error).message });
        }
      },
    );

    // Per-account event stream.
    api.get('/api/events', { websocket: true }, (socket: any, req) => {
      const account = store.verifyToken(bearer(req));
      if (!account) {
        socket.close();
        return;
      }
      const host = hostFor(account);
      const onAgent = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.agentEvent, payload: e }));
      const onIndex = (s: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.indexProgress, payload: s }));
      const onTerminal = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.terminalEvent, payload: e }));
      const onOauth = (s: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.oauthStatus, payload: s }));
      const onLimits = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.limitsUpdated, payload: e }));
      const onModels = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.modelsUpdated, payload: e }));
      const onSkills = (c: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.skillsUpdated, payload: c }));
      host.events.on('agentEvent', onAgent);
      host.events.on('indexProgress', onIndex);
      host.events.on('terminalEvent', onTerminal);
      host.events.on('oauthStatus', onOauth);
      host.events.on('limitsUpdated', onLimits);
      host.events.on('modelsUpdated', onModels);
      host.events.on('skillsUpdated', onSkills);
      socket.on('close', () => {
        host.events.off('agentEvent', onAgent);
        host.events.off('indexProgress', onIndex);
        host.events.off('terminalEvent', onTerminal);
        host.events.off('oauthStatus', onOauth);
        host.events.off('limitsUpdated', onLimits);
        host.events.off('modelsUpdated', onModels);
        host.events.off('skillsUpdated', onSkills);
      });
    });
  });

  // Stripe webhook, encapsulated so its RAW-body parser (needed for signature
  // verification) doesn't touch the JSON `/api/:channel` routes above.
  app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hook.post('/api/billing/webhook', async (req, reply) => {
      const raw = (req.body instanceof Buffer ? req.body : Buffer.from(String(req.body ?? ''))).toString('utf8');
      const event = billing.parseWebhook(raw, req.headers['stripe-signature'] as string | undefined);
      if (!event) return reply.code(400).send({ error: 'invalid signature' });
      const change = planChangeFromEvent(event, billing);
      if (change) {
        const account =
          (change.accountId ? store.get(change.accountId) : undefined) ??
          (change.customerId ? store.findByStripeCustomer(change.customerId) : undefined);
        if (account) {
          if (change.customerId) store.setStripeCustomer(account.id, change.customerId);
          store.setPlan(account.id, change.plan);
        }
      }
      reply.send({ received: true });
    });
  });

  // Serve the renderer (same UI as desktop/web) when a build is available.
  if (opts.rendererDir && existsSync(join(opts.rendererDir, 'index.html'))) {
    app.register(fastifyStatic, { root: opts.rendererDir, prefix: '/' });
  }

  return { app, store };
}
