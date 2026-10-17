import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { RepositoryReviewer } from '@nekko-agent/host';

export interface GitHubReviewConfig {
  appId: string; privateKey: string; secret: string; bot: string;
  repositories: string[]; requesters: string[]; autoApprove: boolean;
}
export function githubReviewConfig(env: (key: string) => string | undefined): GitHubReviewConfig | undefined {
  if (env('GITHUB_APP_ENABLED') !== '1') return;
  const required = (key: string) => { const value = env(key)?.trim(); if (!value) throw new Error(`Missing ${key}`); return value; };
  const list = (key: string) => required(key).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const config = {
    appId: required('GITHUB_APP_ID'), privateKey: required('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
    secret: required('GITHUB_APP_WEBHOOK_SECRET'), bot: required('GITHUB_APP_BOT_LOGIN'),
    repositories: list('GITHUB_APP_REPOSITORIES'), requesters: list('GITHUB_APP_REQUESTERS'),
    autoApprove: env('GITHUB_APP_AUTO_APPROVE') === '1',
  };
  if (!/^\d+$/.test(config.appId) || !/^[a-z0-9-]+(?:\[bot\])?$/i.test(config.bot) ||
      !config.repositories.length || !config.repositories.every((r) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(r)) ||
      !config.requesters.length || !config.requesters.every((r) => /^[a-z0-9-]+$/.test(r))) throw new Error('Invalid GitHub App allowlists or identity');
  createSign('RSA-SHA256').update('configuration-check').sign(config.privateKey);
  return config;
}
export function verifyGitHubSignature(raw: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

/** Durable at-most-once claims. Fail closed on corrupt state; never retry an uncertain POST. Single process only. */
export class ReviewReplayLedger {
  private entries: Record<string, number>;
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'github-review-replay.json');
    try { this.entries = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.entries = {}; }
    if (!this.entries || Array.isArray(this.entries) || typeof this.entries !== 'object' || Object.values(this.entries).some((n) => typeof n !== 'number')) throw new Error('Invalid replay ledger');
  }
  claim(keys: string[]): boolean {
    if (keys.some((k) => Object.hasOwn(this.entries, k))) return false;
    // Do not expire event identities: old signed deliveries must not become executable again.
    if (Object.keys(this.entries).length + keys.length > 100_000) throw new Error('Replay ledger full');
    for (const key of keys) this.entries[key] = Date.now();
    writeFileSync(this.file, JSON.stringify(this.entries), { mode: 0o600 });
    return true;
  }
}

export class GitHubAppClient {
  constructor(private config: GitHubReviewConfig, private fetcher: typeof fetch = fetch) {}
  async request(path: string, token: string, method = 'GET', body?: unknown): Promise<{ data: any; linked: boolean }> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub API failed (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing GitHub response');
    const chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1_000_000) throw new Error('GitHub response too large'); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel(); }
    return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), linked: !!response.headers.get('link') };
  }
  async installationToken(id: number, repository: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: this.config.appId })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.config.privateKey, 'base64url');
    const { data } = await this.request(`/app/installations/${id}/access_tokens`, `${unsigned}.${signature}`, 'POST', {
      repositories: [repository], permissions: { pull_requests: 'write', contents: 'read' },
    });
    if (typeof data.token !== 'string' || !data.token) throw new Error('Missing installation token');
    return data.token;
  }
}

export function reviewPrompt(body: string, bot: string): { prompt: string; approve: boolean } | undefined {
  // Deliberately require a top-level command, not a mention embedded in quoted PR content.
  const prefix = `@${bot} `;
  if (!body.toLowerCase().startsWith(prefix.toLowerCase()) || body.length > 4000) return;
  const command = body.slice(prefix.length);
  const match = /^(review|approve)(?:\s+([\s\S]+))?$/.exec(command);
  if (!match) return;
  return { prompt: match[2]?.trim() || 'Review correctness and security.', approve: match[1] === 'approve' };
}

export function registerGitHubReviewRoutes(app: FastifyInstance, config: GitHubReviewConfig, reviewer: RepositoryReviewer, ledger: ReviewReplayLedger, client = new GitHubAppClient(config)): void {
  let busy = false;
  app.register(async (scope) => {
    // Limit before signature verification/model work. A single global bucket
    // bounds memory and cannot be bypassed by rotating source IPs.
    await scope.register(rateLimit, { max: 30, timeWindow: '1 minute', keyGenerator: () => 'github-review' });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256_000 }, (_req, body, done) => done(null, body));
    scope.post('/hooks/github/review', { bodyLimit: 256_000 }, async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyGitHubSignature(raw, req.headers['x-hub-signature-256'], config.secret)) return reply.code(401).send({ error: 'invalid signature' });
      const delivery = req.headers['x-github-delivery'];
      if (typeof delivery !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery)) return reply.code(400).send({ error: 'invalid delivery' });
      let event: any;
      try { event = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'invalid JSON' }); }
      if (req.headers['x-github-event'] !== 'issue_comment' || event.action !== 'created') return { ignored: true };
      const repo = event.repository?.full_name;
      const requester = event.sender?.login;
      const comment = event.comment;
      const number = event.issue?.number;
      if (typeof repo !== 'string' || !config.repositories.includes(repo.toLowerCase()) ||
          typeof requester !== 'string' || !config.requesters.includes(requester.toLowerCase()) ||
          event.sender?.type !== 'User' || comment?.user?.login !== requester || comment?.user?.type !== 'User' ||
          !event.issue?.pull_request || !Number.isSafeInteger(number) || number <= 0 ||
          !Number.isSafeInteger(comment?.id) || comment.id <= 0 ||
          !Number.isSafeInteger(event.installation?.id) || event.installation.id <= 0 || typeof comment.body !== 'string') return { ignored: true };
      const command = reviewPrompt(comment.body, config.bot);
      if (!command) return { ignored: true };
      if (busy) return reply.code(503).send({ error: 'review worker busy; redeliver later' });
      busy = true;
      try {
        if (!ledger.claim([`delivery:${delivery}`, `comment:${repo.toLowerCase()}:${comment.id}`])) return { duplicate: true };
        const token = await client.installationToken(event.installation.id, repo.split('/')[1]);
        const path = `/repos/${repo}/pulls/${number}`;
        const { data: pr } = await client.request(path, token);
        const safe = (p: any) => p.state === 'open' && !p.draft && p.base?.repo?.full_name?.toLowerCase() === repo.toLowerCase() && p.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() && /^[a-f0-9]{40}$/.test(p.head?.sha);
        if (!safe(pr)) throw new Error('Closed, draft, fork or invalid PR');
        if (!Number.isInteger(pr.changed_files) || pr.changed_files < 1 || pr.changed_files > 100) throw new Error('Diff requires pagination or has no files');
        const { data: files, linked } = await client.request(`${path}/files?per_page=100`, token);
        if (linked || !Array.isArray(files) || files.length !== pr.changed_files) throw new Error('Incomplete or paginated diff');
        let total = 0;
        for (const f of files) {
          if (typeof f.filename !== 'string' || typeof f.status !== 'string' || typeof f.patch !== 'string' || !Number.isInteger(f.additions) || !Number.isInteger(f.deletions)) throw new Error('Missing patch');
          const lines = f.patch.split('\n');
          const additions = lines.filter((l: string) => l.startsWith('+')).length;
          const deletions = lines.filter((l: string) => l.startsWith('-')).length;
          if (additions !== f.additions || deletions !== f.deletions) throw new Error('Truncated patch');
          total += Buffer.byteLength(f.patch) + Buffer.byteLength(f.filename);
        }
        if (total > 120_000 || typeof pr.title !== 'string' || pr.title.length > 1000 || (pr.body?.length ?? 0) > 12_000) throw new Error('Review input too large');
        const head = pr.head.sha;
        const verdict = await reviewer({ head, prompt: command.prompt, title: pr.title, description: pr.body ?? '', files: files.map((f: any) => ({ filename: f.filename, status: f.status, patch: f.patch })) });
        if (verdict.reviewedHead !== head || !verdict.complete || !['APPROVE', 'COMMENT'].includes(verdict.verdict) || typeof verdict.summary !== 'string' || !verdict.summary.trim() || verdict.summary.length > 4000) throw new Error('Inconclusive review');
        const { data: current } = await client.request(path, token);
        if (!safe(current) || current.head.sha !== head || current.base.sha !== pr.base.sha) throw new Error('PR changed during review');
        const approve = config.autoApprove && command.approve && verdict.verdict === 'APPROVE';
        // Claim before sending: a timeout can leave a successful review behind. Never replay it.
        if (!ledger.claim([`review:${repo.toLowerCase()}:${number}:${head}:${comment.id}`])) return { duplicate: true };
        await client.request(`${path}/reviews`, token, 'POST', {
          commit_id: head, event: approve ? 'APPROVE' : 'COMMENT',
          body: `Reviewed commit ${head}.\n\n${verdict.summary}`,
        });
        return { reviewed: true, approved: approve, head };
      } catch {
        req.log.warn('GitHub review failed closed; delivery will not be replayed');
        return reply.code(422).send({ error: 'Review not submitted; inspect configuration or request a new review comment' });
      } finally { busy = false; }
    });
  });
}
