/**
 * Workflow action steps, the sink side of automations. A step's `run` names an
 * op from the shared WORKFLOW_ACTIONS catalog (`slack.postMessage`,
 * `github.setCommitStatus`, …) and its `params` carry that op's inputs, already
 * template-interpolated by the executor (see renderTemplate).
 *
 * Each runner gets the *stored connector config* — token and settings from
 * settings.json, resolved by the host — so credentials never live on the step.
 * A runner returns a ToolResult-shaped outcome (`output` + `isError`); thrown
 * errors (missing params, bad URLs) are normalized by runWorkflowAction.
 */
import type { ConnectorConfig, ToolResult, WorkflowActionSpec, WorkflowEvent } from '@nekko-agent/shared';
import { findWorkflowAction, slugify } from '@nekko-agent/shared';
import { gitlabBase } from './index.js';

/** An action's outcome, ToolResult-shaped: text for the run log + an error flag. */
export type WorkflowActionResult = Omit<ToolResult, 'toolCallId'>;

/** What the executor hands a runner beyond its params. */
export interface WorkflowActionContext {
  /** The event that fired the run (undefined for a manual start). */
  event?: WorkflowEvent;
  /** The run the step belongs to, for defaults like the `nekko-agent/<wf>` context. */
  run?: {
    id: string;
    workflowId: string;
    workflowName: string;
    status: string;
    triggerKind?: string;
    triggerLabel?: string;
  };
}

export type WorkflowActionRunner = (
  config: ConnectorConfig | undefined,
  params: Record<string, string>,
  ctx: WorkflowActionContext,
) => Promise<WorkflowActionResult>;

/** A catalog op plus the code that performs it. */
export interface WorkflowAction extends WorkflowActionSpec {
  run: WorkflowActionRunner;
}

/* ------------------------------------------------------------------ *
 * Templates
 *
 * Step fields interpolate `{{trigger.*}}` (the event that fired the run,
 * payload keys included), `{{steps.<stepId>.output}}` (a finished step's
 * output), and `{{run.*}}` (the run itself). A missing leaf resolves to an
 * empty string; a `{{…}}` that doesn't start from a known root is left alone
 * so ordinary braces in text survive.
 * ------------------------------------------------------------------ */

export interface WorkflowTemplateContext {
  trigger?: Record<string, unknown>;
  steps?: Record<string, { output?: string }>;
  run?: Record<string, unknown>;
}

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function renderTemplate(template: string, ctx: WorkflowTemplateContext): string {
  if (!template.includes('{{')) return template;
  return template.replace(TEMPLATE_RE, (match, path: string) => {
    const [root, ...rest] = path.split('.');
    const source = (ctx as Record<string, unknown>)[root];
    if (rest.length === 0 || source == null || typeof source !== 'object') return match;
    let cur: unknown = source;
    for (const seg of rest) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur == null) return '';
    if (typeof cur === 'string') return cur;
    return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
  });
}

/** Build the interpolation context for a step about to run. */
export function templateContext(opts: {
  event?: WorkflowEvent;
  /** Latest output per step id, for `{{steps.<stepId>.output}}`. */
  outputs?: Map<string, string>;
  run?: WorkflowActionContext['run'];
}): WorkflowTemplateContext {
  const { event, outputs, run } = opts;
  const trigger: Record<string, unknown> | undefined = event
    ? {
        kind: event.kind,
        provider: event.provider,
        event: event.event,
        repo: event.repo,
        branch: event.branch,
        command: event.command,
        channel: event.channel,
        text: event.text,
        // Payload keys ride at the top level so `{{trigger.sha}}` works
        // without knowing which envelope field carried it.
        ...(event.payload ?? {}),
      }
    : undefined;
  const steps: Record<string, { output: string }> = {};
  for (const [id, output] of outputs ?? []) steps[id] = { output };
  return { trigger, steps, run: run ? { ...run } : undefined };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const ok = (output: string): WorkflowActionResult => ({ output });
const fail = (output: string): WorkflowActionResult => ({ output, isError: true });

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

/**
 * Resolve a possibly-dotted path (`pull_request.head.sha`) against an object,
 * returning the leaf as a string. Non-scalar leaves (objects, arrays) count as
 * a miss so a wrapper key can't shadow a deeper real value.
 */
function dig(obj: unknown, path: string): string {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur == null || typeof cur === 'object') return '';
  return str(cur);
}

/**
 * First non-empty of the step's param, then the event's field, then payload
 * keys. Keys may be dotted paths, which is what makes a raw provider webhook
 * body (GitHub's `repository.full_name`, GitLab's `object_attributes.iid`)
 * usable without a normalizing relay in front.
 */
function pick(params: Record<string, string>, key: string, ctx: WorkflowActionContext, ...eventKeys: string[]): string {
  const own = str(params[key]);
  if (own) return own;
  for (const k of eventKeys) {
    const top = dig(ctx.event, k);
    if (top) return top;
    const payload = dig(ctx.event?.payload, k);
    if (payload) return payload;
  }
  return '';
}

function required(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function needToken(config: ConnectorConfig | undefined, name: string): string {
  const t = config?.token?.trim();
  if (!t) throw new Error(`The ${name} connector has no token saved. Reconnect it under Connectors.`);
  return t;
}

/** Read a short error out of a failed response. */
async function httpError(res: Response, label: string): Promise<WorkflowActionResult> {
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
  return fail(`${label} failed: ${res.status}${body ? `: ${body}` : ''}`);
}

/** Linear's GraphQL door; every op goes through this one POST. */
async function linearGql(tok: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: tok },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Linear ${res.status}`);
  if (json?.errors?.length) throw new Error(`Linear: ${json.errors[0].message ?? 'GraphQL error'}`);
  return json?.data;
}

/** Jira's Basic-auth header set, reusing the connector's site + email settings. */
function jiraAuth(config: ConnectorConfig | undefined): { site: string; headers: Record<string, string> } {
  const site = (config?.settings?.site ?? '').trim().replace(/\/+$/, '');
  const email = (config?.settings?.email ?? '').trim();
  const tok = needToken(config, 'Jira');
  if (!site || !email) throw new Error('Jira needs a site URL and the account email (set on the connector).');
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    throw new Error(`Jira site "${site}" isn't a valid URL.`);
  }
  if (u.protocol !== 'https:') throw new Error('The Jira site URL must be https.');
  return {
    site,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${tok}`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  };
}

/** Wrap plain text in the Atlassian Document Format Jira Cloud requires. */
function adfDoc(text: string) {
  return { version: 1, type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] };
}

const GITHUB_HEADERS = (tok: string) => ({
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nekko-agent',
  'Content-Type': 'application/json',
});

/** `owner/name` shape check — a repo param that isn't that would just 404 anyway. */
function repoPath(value: string): string {
  const repo = value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Repo "${repo}" should look like owner/name.`);
  return repo;
}

/* ------------------------------------------------------------------ *
 * The runners, one per WORKFLOW_ACTIONS op.
 * ------------------------------------------------------------------ */

const RUNNERS: Partial<Record<string, WorkflowActionRunner>> = {
  'slack.postMessage': async (config, params) => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${needToken(config, 'Slack')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: required(str(params.channel), 'Channel').replace(/^#/, ''),
        text: required(str(params.text), 'Message'),
      }),
    });
    const json: any = await res.json().catch(() => null);
    // Slack answers 200 with { ok: false, error } for most API failures.
    if (!res.ok || !json?.ok) return fail(`Slack postMessage failed: ${json?.error ?? `HTTP ${res.status}`}`);
    return ok(`Posted to Slack (${json.channel ?? 'channel'}, ts ${json.ts ?? ''})`.trim());
  },

  'linear.createIssue': async (config, params) => {
    const tok = needToken(config, 'Linear');
    const want = required(str(params.team), 'Team').toLowerCase();
    const teams = (await linearGql(tok, '{ teams(first: 100) { nodes { id key name } } }'))?.teams?.nodes ?? [];
    const team = teams.find(
      (t: any) => t.id === want || str(t.key).toLowerCase() === want || str(t.name).toLowerCase() === want,
    );
    if (!team) throw new Error(`No Linear team matches "${params.team}".`);
    const input: Record<string, unknown> = { teamId: team.id, title: required(str(params.title), 'Title') };
    if (str(params.description)) input.description = str(params.description);
    const data = await linearGql(
      tok,
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }',
      { input },
    );
    const issue = data?.issueCreate?.issue;
    if (!data?.issueCreate?.success || !issue) return fail('Linear issueCreate did not succeed.');
    return ok(`Created ${issue.identifier}${issue.url ? ` ${issue.url}` : ''}`);
  },

  'linear.commentIssue': async (config, params) => {
    const tok = needToken(config, 'Linear');
    const want = required(str(params.issue), 'Issue');
    // issue(id:) accepts both the UUID and the human identifier (ENG-123).
    const data = await linearGql(tok, 'query($id: String!) { issue(id: $id) { id identifier } }', { id: want });
    if (!data?.issue?.id) throw new Error(`No Linear issue matches "${want}".`);
    const res = await linearGql(
      tok,
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
      { input: { issueId: data.issue.id, body: required(str(params.body), 'Comment') } },
    );
    if (!res?.commentCreate?.success) return fail('Linear commentCreate did not succeed.');
    return ok(`Commented on ${data.issue.identifier}`);
  },

  'jira.createIssue': async (config, params) => {
    const { site, headers } = jiraAuth(config);
    const res = await fetch(`${site}/rest/api/3/issue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fields: {
          project: { key: required(str(params.project), 'Project') },
          summary: required(str(params.summary), 'Summary'),
          issuetype: { name: str(params.issueType) || 'Task' },
          description: adfDoc(str(params.description)),
        },
      }),
    });
    if (!res.ok) return httpError(res, 'Jira createIssue');
    const json: any = await res.json().catch(() => null);
    return ok(`Created ${json?.key ?? 'issue'}${json?.key ? ` ${site}/browse/${json.key}` : ''}`);
  },

  'jira.commentIssue': async (config, params) => {
    const { site, headers } = jiraAuth(config);
    const key = required(str(params.issue), 'Issue key');
    const res = await fetch(`${site}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: adfDoc(required(str(params.body), 'Comment')) }),
    });
    if (!res.ok) return httpError(res, `Jira comment on ${key}`);
    return ok(`Commented on ${key}`);
  },

  'github.commentPR': async (config, params, ctx) => {
    const repo = repoPath(required(pick(params, 'repo', ctx, 'repo', 'repository.full_name'), 'Repo'));
    const number = required(
      pick(params, 'number', ctx, 'number', 'pull_number', 'issue_number', 'pull_request.number', 'issue.number'),
      'PR number',
    ).replace(/^#/, '');
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${encodeURIComponent(number)}/comments`, {
      method: 'POST',
      headers: GITHUB_HEADERS(needToken(config, 'GitHub')),
      body: JSON.stringify({ body: required(str(params.body), 'Comment') }),
    });
    if (!res.ok) return httpError(res, `GitHub comment on ${repo}#${number}`);
    const json: any = await res.json().catch(() => null);
    return ok(`Commented on ${repo}#${number}${json?.html_url ? ` ${json.html_url}` : ''}`);
  },

  'github.setCommitStatus': async (config, params, ctx) => {
    const repo = repoPath(required(pick(params, 'repo', ctx, 'repo', 'repository.full_name'), 'Repo'));
    const sha = required(
      pick(
        params,
        'sha',
        ctx,
        'sha',
        'after',
        'head_sha',
        'checkout_sha',
        'head',
        'head_commit.id',
        'pull_request.head.sha',
        'object_attributes.last_commit.id',
      ),
      'Commit SHA',
    );
    // Accept GitLab's spelling too so a {{run.status}} template works on both.
    const raw = required(str(params.state), 'State').toLowerCase();
    const state = raw === 'failed' ? 'failure' : raw;
    if (!['error', 'failure', 'pending', 'success'].includes(state)) {
      throw new Error(`GitHub commit state "${raw}" must be success, failure, error, or pending.`);
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/statuses/${encodeURIComponent(sha)}`, {
      method: 'POST',
      headers: GITHUB_HEADERS(needToken(config, 'GitHub')),
      body: JSON.stringify({
        state,
        context: str(params.context) || `nekko-agent/${slugify(ctx.run?.workflowName ?? 'workflow')}`,
        ...(str(params.description) ? { description: str(params.description).slice(0, 140) } : {}),
        ...(str(params.targetUrl) ? { target_url: str(params.targetUrl) } : {}),
      }),
    });
    if (!res.ok) return httpError(res, `GitHub commit status on ${repo}@${sha.slice(0, 8)}`);
    return ok(`Set ${repo}@${sha.slice(0, 8)} → ${state}`);
  },

  'gitlab.setCommitStatus': async (config, params, ctx) => {
    const base = gitlabBase(config?.settings);
    const project = encodeURIComponent(
      required(pick(params, 'project', ctx, 'repo', 'project', 'project.path_with_namespace', 'project_id'), 'Project'),
    );
    const sha = required(
      pick(params, 'sha', ctx, 'sha', 'after', 'checkout_sha', 'head_commit.id', 'object_attributes.last_commit.id'),
      'Commit SHA',
    );
    const raw = required(str(params.state), 'State').toLowerCase();
    // Same spelling bridge as the GitHub op, in the other direction.
    const state = raw === 'failure' ? 'failed' : raw;
    if (!['pending', 'running', 'success', 'failed', 'canceled'].includes(state)) {
      throw new Error(`GitLab commit state "${raw}" must be success, failed, running, pending, or canceled.`);
    }
    const qs = new URLSearchParams({ state });
    qs.set('name', str(params.name) || `nekko-agent/${slugify(ctx.run?.workflowName ?? 'workflow')}`);
    if (str(params.description)) qs.set('description', str(params.description));
    if (str(params.targetUrl)) qs.set('target_url', str(params.targetUrl));
    const res = await fetch(`${base}/api/v4/projects/${project}/statuses/${encodeURIComponent(sha)}?${qs}`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': needToken(config, 'GitLab') },
    });
    if (!res.ok) return httpError(res, `GitLab commit status on ${decodeURIComponent(project)}@${sha.slice(0, 8)}`);
    return ok(`Set ${decodeURIComponent(project)}@${sha.slice(0, 8)} → ${state}`);
  },

  'gitlab.commentMR': async (config, params, ctx) => {
    const base = gitlabBase(config?.settings);
    const project = encodeURIComponent(
      required(pick(params, 'project', ctx, 'repo', 'project', 'project.path_with_namespace', 'project_id'), 'Project'),
    );
    const iid = required(pick(params, 'mr', ctx, 'iid', 'number', 'object_attributes.iid'), 'MR number').replace(/^!/, '');
    const res = await fetch(`${base}/api/v4/projects/${project}/merge_requests/${encodeURIComponent(iid)}/notes`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': needToken(config, 'GitLab'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: required(str(params.body), 'Comment') }),
    });
    if (!res.ok) return httpError(res, `GitLab comment on ${decodeURIComponent(project)}!${iid}`);
    return ok(`Commented on ${decodeURIComponent(project)}!${iid}`);
  },

  'discord.postMessage': async (config, params) => {
    const channel = required(str(params.channel), 'Channel id');
    const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${needToken(config, 'Discord')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: required(str(params.text), 'Message') }),
    });
    if (!res.ok) return httpError(res, 'Discord postMessage');
    return ok(`Posted to Discord channel ${channel}`);
  },

  'teams.postMessage': async (config, params) => {
    const webhook = (config?.settings?.webhookUrl ?? '').trim();
    if (!webhook) throw new Error('The Teams connector has no incoming webhook URL saved.');
    let u: URL;
    try {
      u = new URL(webhook);
    } catch {
      throw new Error("The saved Teams webhook URL isn't valid.");
    }
    const host = u.hostname.toLowerCase();
    // Same check the connector applies: a stored credential that gets POSTed
    // to has to be a real Teams incoming webhook, not just any https URL.
    if (u.protocol !== 'https:' || (host !== 'webhook.office.com' && !host.endsWith('.webhook.office.com'))) {
      throw new Error('The Teams webhook URL must be an https URL on *.webhook.office.com.');
    }
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: required(str(params.text), 'Message') }),
    });
    if (!res.ok) return httpError(res, 'Teams postMessage');
    return ok('Posted to the Teams channel.');
  },

  'webhook.post': async (_config, params) => {
    const raw = required(str(params.url), 'URL');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`"${raw}" isn't a valid URL.`);
    }
    // An action step fires unattended, so the target has to be a plain https
    // endpoint — http would leak the body, and file:// isn't a POST target.
    if (u.protocol !== 'https:') throw new Error('webhook.post only sends to https URLs.');
    const res = await fetch(raw, {
      method: 'POST',
      // Never follow a redirect: it could hand the body to a downgraded or
      // different host than the one that was configured.
      redirect: 'manual',
      headers: {
        'Content-Type': str(params.contentType) || 'application/json',
        'User-Agent': 'nekko-agent-workflow',
      },
      body: required(str(params.body), 'Body'),
    });
    if (!res.ok) return httpError(res, `POST ${u.host}`);
    return ok(`POST ${u.host}${u.pathname === '/' ? '' : u.pathname} → ${res.status}`);
  },
};

/** An op's catalog metadata plus its runner, or undefined for an unknown op. */
export function getWorkflowAction(op: string): WorkflowAction | undefined {
  const spec = findWorkflowAction(op);
  const run = RUNNERS[op];
  return spec && run ? { ...spec, run } : undefined;
}

/**
 * Run one action by name. Normalizes every failure into the ToolResult shape
 * so the executor can record it as a failed step without a try/catch of its
 * own.
 */
export async function runWorkflowAction(
  op: string,
  config: ConnectorConfig | undefined,
  params: Record<string, string>,
  ctx: WorkflowActionContext,
): Promise<WorkflowActionResult> {
  const action = getWorkflowAction(op);
  if (!action) return fail(`Unknown action "${op}". Pick one from the action list.`);
  try {
    return await action.run(config, params, ctx);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
