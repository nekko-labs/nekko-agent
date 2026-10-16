import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectorConfig, ConnectorKind } from '@nekko-agent/shared';
import { getConnector } from './index.js';
import { renderTemplate, runWorkflowAction, templateContext } from './actions.js';

/**
 * What the connectors and the workflow actions send and return, which the
 * engine daemon's port (crates/nekko-connectors) must reproduce exactly:
 * every request (method, URL, headers in order, body as JSON.stringify
 * prints it) and every result or error, against scripted responses. Also the
 * template rendering the workflow engine applies to step fields. Fails if the
 * file is stale; rewrite it with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-connectors');

function check(path: string, actual: unknown): void {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
}

afterEach(() => vi.unstubAllGlobals());

/** A scripted response: a status and a body (text, or a value sent as JSON). */
interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Run `f` with `fetch` answering from `replies` in order, recording each request. */
async function recorded<T>(replies: Reply[], f: () => Promise<T>) {
  const requests: unknown[] = [];
  const queue = [...replies];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const headers = init?.headers ? Object.entries(init.headers as Record<string, string>) : [];
    requests.push({ method: init?.method ?? 'GET', url: String(url), headers, body: init?.body ?? null, redirect: init?.redirect ?? null });
    const next = queue.shift();
    if (!next) throw new TypeError('fetch failed');
    const status = next.status ?? 200;
    const text = next.text ?? (next.json === undefined ? '' : JSON.stringify(next.json));
    return new Response(status === 204 ? null : text, { status });
  });
  try {
    return { requests, result: await f() };
  } catch (e) {
    return { requests, error: (e as Error).message };
  }
}

type FetchCase = { kind: ConnectorKind; token: string; query?: string; settings?: Record<string, string>; replies: Reply[] };
type PollCase = { kind: ConnectorKind; token: string; settings: Record<string, string>; cursor: number; replies: Reply[] };

const CURSOR = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
const iso = (ms: number) => new Date(ms).toISOString();

const FETCHES: FetchCase[] = [
  { kind: 'github', token: 'gh', replies: [{ json: [{ id: 1, full_name: 'o/r', private: true, html_url: 'https://g/o/r', description: 'd' }, { id: 2, full_name: 'o/s', private: false, html_url: 'u' }] }] },
  { kind: 'github', token: 'gh', query: 'is:pr "fix" ü', replies: [{ json: { items: [{ id: 7, title: 'T', pull_request: {}, repository_url: 'https://api.github.com/repos/o/r', number: 3, html_url: 'h', body: null }, { id: 8, title: 'I', number: 4, html_url: 'h2', body: 'b' }] } }] },
  { kind: 'github', token: 'gh', replies: [{ status: 401, json: { message: 'bad' } }] },
  { kind: 'github', token: 'gh', query: 'x', replies: [{ json: {} }] },
  { kind: 'linear', token: 'lin', replies: [{ json: { data: { issues: { nodes: [{ id: 'a', identifier: 'ENG-1', title: 'Fix', url: 'u', description: null }] } } } }] },
  { kind: 'linear', token: 'lin', query: 'crash "x"', replies: [{ json: { data: { searchIssues: { nodes: [{ id: 'b', identifier: 'ENG-2', title: 'Crash', url: 'u2', description: 'd' }] } } } }] },
  { kind: 'linear', token: 'lin', replies: [{ status: 500, text: 'oops' }] },
  { kind: 'slack', token: 'xoxb', replies: [{ json: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, purpose: { value: 'talk' } }, { id: 'C2', name: 'sec', is_private: true }] } }] },
  { kind: 'slack', token: 'xoxb', query: 'deploy & ship', replies: [{ json: { ok: true, messages: { matches: [{ iid: 'i1', text: 'x'.repeat(100), channel: { name: 'ops' }, permalink: 'p' }, { ts: '1.2', text: null }] } } }] },
  { kind: 'slack', token: 'xoxb', replies: [{ json: { ok: false, error: 'invalid_auth' } }] },
  { kind: 'slack', token: 'xoxb', replies: [{ json: { ok: false } }] },
  { kind: 'discord', token: 'bot', replies: [{ json: [{ id: 'g1', name: 'Guild' }] }] },
  { kind: 'discord', token: 'bot', replies: [{ status: 403 }] },
  { kind: 'gitlab', token: 'glpat', replies: [{ json: [{ id: 5, path_with_namespace: 'g/p', web_url: 'w', description: null }] }] },
  { kind: 'gitlab', token: 'glpat', query: 'my proj', settings: { site: 'https://gitlab.example.com/' }, replies: [{ json: [] }] },
  { kind: 'gitlab', token: 'glpat', settings: { site: 'http://gitlab.example.com' }, replies: [] },
  { kind: 'gitlab', token: 'glpat', settings: { site: 'not a url' }, replies: [] },
  { kind: 'gitlab', token: 'glpat', settings: { site: 'https://gitlab.example.com/sub' }, replies: [] },
  { kind: 'gitlab', token: 'glpat', replies: [{ status: 404 }] },
  { kind: 'jira', token: 'jt', settings: { site: 'https://acme.atlassian.net/', email: ' me@acme.io ' }, replies: [{ json: { issues: [{ id: '10', key: 'AC-1', fields: { summary: 'Sum', issuetype: { name: 'Bug' }, status: { name: 'Open' }, description: 'plain' } }, { key: 'AC-2', fields: { description: { type: 'doc' } } }] } }] },
  { kind: 'jira', token: 'jt', query: 'a "b" + c (d) [e] : f/g \\ h', settings: { site: 'https://acme.atlassian.net', email: 'me@acme.io' }, replies: [{ status: 410 }, { json: { issues: [] } }] },
  { kind: 'jira', token: 'jt', settings: { site: 'https://acme.atlassian.net', email: 'me@acme.io' }, replies: [{ status: 404 }, { status: 404 }] },
  { kind: 'jira', token: 'jt', settings: { site: '', email: 'x' }, replies: [] },
  { kind: 'jira', token: 'jt', settings: { site: 'http://acme', email: 'x' }, replies: [] },
  { kind: 'jira', token: 'jt', settings: { site: 'acme', email: 'x' }, replies: [] },
  { kind: 'teams', token: 'graph', replies: [{ json: { value: [{ id: 't1', displayName: 'Eng', description: 'd' }, { id: 't2' }] } }] },
  { kind: 'teams', token: 'graph', query: 'EN', replies: [{ json: { value: [{ id: 't1', displayName: 'Eng' }, { id: 't2', displayName: 'Ops' }] } }] },
  { kind: 'teams', token: 'graph', replies: [{ status: 401 }] },
  { kind: 'teams', token: '', settings: { webhookUrl: ' https://acme.webhook.office.com/x ' }, replies: [] },
  { kind: 'teams', token: '', settings: { webhookUrl: 'https://WEBHOOK.office.com/x' }, replies: [] },
  { kind: 'teams', token: '', settings: { webhookUrl: 'https://evil.com/x' }, replies: [] },
  { kind: 'teams', token: '', settings: { webhookUrl: 'nope' }, replies: [] },
  { kind: 'teams', token: '', replies: [] },
  { kind: 'gmail', token: 'g', query: 'from:me', replies: [{ json: { messages: [{ id: 'm1' }] } }] },
  { kind: 'gmail', token: 'g', replies: [{ status: 401 }] },
  { kind: 'gdrive', token: 'g', query: "q's", replies: [{ json: { files: [{ id: 'f1', name: 'Doc', mimeType: 'text/plain' }] } }] },
  { kind: 'gdrive', token: 'g', replies: [{ status: 403 }] },
  { kind: 'github', token: 'gh', replies: [] },
  { kind: 'trello', token: 'tt', settings: { key: ' k&1 ' }, replies: [{ json: [{ id: 'c1', name: 'Ship it', desc: null, shortUrl: 'https://trello.com/c/1', due: '2026-05-01T00:00:00.000Z' }, { id: 2, name: 'Other' }] }] },
  { kind: 'trello', token: 'tt', query: 'SHIP', settings: { key: 'k' }, replies: [{ json: [{ id: 'c1', name: 'Ship it' }, { id: 'c2', name: 'x', desc: 'ship later' }, { id: 'c3', name: 'no' }] }] },
  { kind: 'trello', token: 'tt', settings: {}, replies: [] },
  { kind: 'trello', token: 'tt', settings: { key: 'k' }, replies: [{ status: 401, text: 'invalid key' }] },
  { kind: 'asana', token: 'pat', replies: [{ json: { data: { workspaces: [{ gid: 'w 1' }] } } }, { json: { data: [{ gid: 1, name: 'Write spec', notes: 'n', permalink_url: 'u', due_on: '2026-06-01' }, { gid: '2', name: null }] } }] },
  { kind: 'asana', token: 'pat', settings: { workspace: 'w9' }, replies: [{ json: { data: [] } }] },
  { kind: 'asana', token: 'pat', replies: [{ json: { data: { workspaces: [] } } }] },
  { kind: 'asana', token: 'pat', replies: [{ status: 403, json: {} }] },
  { kind: 'todoist', token: 'td', replies: [{ json: { results: [{ id: '9', content: 'Buy milk', description: 'x', due: { date: '2026-01-02' } }, { id: 10, content: 'Call', url: 'https://todoist/10', due: null }] } }] },
  { kind: 'todoist', token: 'td', query: 'call', replies: [{ json: [{ id: '1', content: 'Call mum' }, { id: '2', content: 'Other' }] }] },
  { kind: 'todoist', token: 'td', replies: [{ status: 500, text: 'x' }] },
  { kind: 'clickup', token: 'pk_1', replies: [{ json: { teams: [{ id: 42 }] } }, { json: { tasks: [{ id: 'a', name: 'Fix', status: { status: 'open' }, url: 'u', description: 'd' }, { id: 'b', name: 'Nostatus' }] } }] },
  { kind: 'clickup', token: 'pk_1', settings: { team: '7' }, replies: [{ json: { tasks: [] } }] },
  { kind: 'clickup', token: 'pk_1', replies: [{ json: { teams: [] } }] },
  { kind: 'tasksfile', token: '', settings: {}, replies: [] },
];

const POLLS: PollCase[] = [
  { kind: 'github', token: 'gh', settings: {}, cursor: CURSOR, replies: [{ json: [
    { id: '1', type: 'PushEvent', created_at: iso(CURSOR + 1000), repo: { name: 'o/r' }, payload: { ref: 'main' } },
    { id: '2', type: 'PullRequestEvent', created_at: iso(CURSOR - 1000), payload: { number: 3, action: 'opened' } },
    { id: '3', type: 'PullRequestEvent', created_at: iso(CURSOR + 5000), payload: { number: 4, action: 'closed' } },
    { id: '4', created_at: 'garbage' },
  ] }] },
  { kind: 'github', token: 'gh', settings: { repo: ' o/r ', event: 'pullrequest', filter: 'CLOSED' }, cursor: CURSOR, replies: [{ json: [
    { id: '3', type: 'PullRequestEvent', created_at: iso(CURSOR + 5000), payload: { number: 4, action: 'closed' } },
    { id: '5', type: 'PullRequestEvent', created_at: iso(CURSOR + 6000), payload: { number: 5, action: 'opened' } },
    { id: '6', type: 'IssuesEvent', created_at: iso(CURSOR + 7000), payload: { action: 'closed' } },
  ] }] },
  { kind: 'github', token: 'gh', settings: {}, cursor: CURSOR, replies: [{ json: [] }] },
  { kind: 'github', token: 'gh', settings: {}, cursor: CURSOR, replies: [{ status: 500 }] },
  { kind: 'linear', token: 'lin', settings: {}, cursor: CURSOR, replies: [{ json: { data: { issues: { nodes: [
    { id: 'a', identifier: 'ENG-1', title: 'Fix', url: 'u', description: null, updatedAt: iso(CURSOR + 10), state: { name: 'Done' } },
    { id: 'b', identifier: 'ENG-2', title: 'Old', updatedAt: iso(CURSOR) },
  ] } } } }] },
  { kind: 'slack', token: 'xoxb', settings: { channel: 'C123', filter: 'Deploy' }, cursor: CURSOR, replies: [{ json: { ok: true, messages: [
    { ts: String((CURSOR + 2000) / 1000), text: 'deploy done' },
    { ts: String((CURSOR + 1000) / 1000), text: 'other' },
    { ts: String((CURSOR + 3000) / 1000), text: 'deploy joined', subtype: 'channel_join' },
    { ts: String((CURSOR - 1000) / 1000), text: 'deploy old' },
  ] } }] },
  { kind: 'slack', token: 'xoxb', settings: { channel: '#ops' }, cursor: 0, replies: [
    { json: { ok: true, channels: [{ id: 'C9', name: 'ops' }] } },
    { json: { ok: true, messages: [{ ts: '1700000000.000100', text: 'y'.repeat(200) }] } },
  ] },
  { kind: 'slack', token: 'xoxb', settings: { channel: '#missing' }, cursor: 0, replies: [{ json: { ok: true, channels: [] } }] },
  { kind: 'slack', token: 'xoxb', settings: { channel: '  ' }, cursor: 0, replies: [] },
  { kind: 'slack', token: 'xoxb', settings: { channel: 'C1' }, cursor: 0, replies: [{ json: { ok: false, error: 'not_in_channel' } }] },
  { kind: 'gitlab', token: 'glpat', settings: { project: 'g/p', event: 'pushed', filter: 'fix' }, cursor: CURSOR, replies: [{ json: [
    { id: 1, project_id: 5, action_name: 'pushed to', created_at: iso(CURSOR + 1), target_title: 'fix bug', target_iid: 7 },
    { id: 2, project_id: 5, action_name: 'pushed to', created_at: iso(CURSOR + 2), push_data: { commit_title: 'fix again' } },
    { id: 3, action_name: 'opened', created_at: iso(CURSOR + 3), target_title: 'fix' },
  ] }] },
  { kind: 'gitlab', token: 'glpat', settings: {}, cursor: CURSOR, replies: [{ json: [{ id: 9, created_at: iso(CURSOR + 9), target_type: 'Issue' }] }] },
  { kind: 'jira', token: 'jt', settings: { site: 'https://acme.atlassian.net', email: 'me@acme.io', filter: 'login' }, cursor: CURSOR, replies: [{ status: 404 }, { json: { issues: [
    { key: 'AC-1', fields: { summary: 'Login broken', updated: '2026-01-02T03:04:06.000+0000', description: 'x' } },
    { key: 'AC-2', fields: { summary: 'Other', updated: '2026-01-02T03:04:07.000+0000', description: 'about LOGIN' } },
    { key: 'AC-3', fields: { summary: 'Login old', updated: '2026-01-01T00:00:00.000+0000' } },
    { key: 'AC-4', fields: { summary: 'login no date' } },
  ] } }] },
  { kind: 'jira', token: 'jt', settings: { site: 'https://acme.atlassian.net', email: '' }, cursor: CURSOR, replies: [] },
];

const SLACK: ConnectorConfig = { kind: 'slack', connected: true, token: ' xoxb-1 ' };
const GITHUB: ConnectorConfig = { kind: 'github', connected: true, token: 'ghp' };
const GITLAB: ConnectorConfig = { kind: 'gitlab', connected: true, token: 'glpat', settings: { site: 'https://gl.example.com' } };
const LINEAR: ConnectorConfig = { kind: 'linear', connected: true, token: 'lin' };
const JIRA: ConnectorConfig = { kind: 'jira', connected: true, token: 'jt', settings: { site: 'https://acme.atlassian.net/', email: 'me@acme.io' } };
const DISCORD: ConnectorConfig = { kind: 'discord', connected: true, token: 'bot' };
const TEAMS: ConnectorConfig = { kind: 'teams', connected: true, settings: { webhookUrl: 'https://acme.webhook.office.com/hook' } };
const RUN = { id: 'r1', workflowId: 'w1', workflowName: 'Ship It!', status: 'success', triggerKind: 'git' };
const PUSH = { kind: 'git' as const, provider: 'github', event: 'push', repo: 'o/r', branch: 'main', payload: { after: 'abcdef0123456789', head_commit: { id: 'h' }, repository: { full_name: 'o/payload' }, pull_request: { number: 12, head: { sha: 'prsha' } } } };

type ActionCase = { op: string; config?: ConnectorConfig; params: Record<string, string>; ctx?: object; replies: Reply[] };
const ACTIONS: ActionCase[] = [
  { op: 'slack.postMessage', config: SLACK, params: { channel: '#ops', text: 'Shipped 🐱' }, replies: [{ json: { ok: true, channel: 'C1', ts: '1.2' } }] },
  { op: 'slack.postMessage', config: SLACK, params: { channel: 'C1', text: 'x' }, replies: [{ json: { ok: false, error: 'channel_not_found' } }] },
  { op: 'slack.postMessage', config: SLACK, params: { channel: 'C1', text: 'x' }, replies: [{ status: 500, text: 'not json' }] },
  { op: 'slack.postMessage', config: SLACK, params: { channel: '', text: 'x' }, replies: [] },
  { op: 'slack.postMessage', config: { kind: 'slack', connected: true }, params: { channel: 'C', text: 'x' }, replies: [] },
  { op: 'slack.postMessage', params: { channel: 'C', text: 'x' }, replies: [] },
  { op: 'linear.createIssue', config: LINEAR, params: { team: 'eng', title: 'Bug', description: ' d ' }, replies: [
    { json: { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } } } },
    { json: { data: { issueCreate: { success: true, issue: { identifier: 'ENG-9', url: 'https://linear/ENG-9' } } } } },
  ] },
  { op: 'linear.createIssue', config: LINEAR, params: { team: 'nope', title: 'Bug' }, replies: [{ json: { data: { teams: { nodes: [] } } } }] },
  { op: 'linear.createIssue', config: LINEAR, params: { team: 't1', title: 'Bug' }, replies: [
    { json: { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } } } },
    { json: { errors: [{ message: 'title too long' }] } },
  ] },
  { op: 'linear.createIssue', config: LINEAR, params: { team: 'Engineering', title: 'Bug' }, replies: [
    { json: { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } } } },
    { json: { data: { issueCreate: { success: false } } } },
  ] },
  { op: 'linear.createIssue', config: LINEAR, params: { team: 'eng', title: 'Bug' }, replies: [{ status: 401, json: {} }] },
  { op: 'linear.commentIssue', config: LINEAR, params: { issue: 'ENG-1', body: 'Looks good' }, replies: [
    { json: { data: { issue: { id: 'i1', identifier: 'ENG-1' } } } },
    { json: { data: { commentCreate: { success: true } } } },
  ] },
  { op: 'linear.commentIssue', config: LINEAR, params: { issue: 'ENG-404', body: 'x' }, replies: [{ json: { data: { issue: null } } }] },
  { op: 'jira.createIssue', config: JIRA, params: { project: 'AC', summary: 'S', description: '' }, replies: [{ status: 201, json: { key: 'AC-5' } }] },
  { op: 'jira.createIssue', config: JIRA, params: { project: 'AC', summary: 'S', issueType: 'Bug', description: 'Details' }, replies: [{ status: 400, text: '{"errors":\n  {"summary": "too long"}}' }] },
  { op: 'jira.createIssue', config: { ...JIRA, settings: { site: 'http://acme', email: 'e' } }, params: { project: 'AC', summary: 'S' }, replies: [] },
  { op: 'jira.commentIssue', config: JIRA, params: { issue: 'AC 1', body: 'Note' }, replies: [{ status: 201, json: {} }] },
  { op: 'github.commentPR', config: GITHUB, params: { body: 'LGTM' }, ctx: { event: PUSH, run: RUN }, replies: [{ status: 201, json: { html_url: 'https://g/c/1' } }] },
  { op: 'github.commentPR', config: GITHUB, params: { repo: 'bad repo', number: '1', body: 'x' }, replies: [] },
  { op: 'github.commentPR', config: GITHUB, params: { repo: 'o/r', number: '#7', body: 'x' }, replies: [{ status: 404, text: '{"message": "Not Found"}' }] },
  { op: 'github.setCommitStatus', config: GITHUB, params: { state: 'FAILED', description: 'd'.repeat(150), targetUrl: 'https://ci/1' }, ctx: { event: PUSH, run: RUN }, replies: [{ status: 201, json: {} }] },
  { op: 'github.setCommitStatus', config: GITHUB, params: { repo: 'o/r', sha: 'abc', state: 'success', context: 'ci/x' }, replies: [{ status: 201, json: {} }] },
  { op: 'github.setCommitStatus', config: GITHUB, params: { repo: 'o/r', sha: 'abc', state: 'done' }, replies: [] },
  { op: 'github.setCommitStatus', config: GITHUB, params: { repo: 'o/r', state: 'success' }, replies: [] },
  { op: 'gitlab.setCommitStatus', config: GITLAB, params: { state: 'failure', description: 'Built & tested', targetUrl: 'https://ci/2' }, ctx: { event: { kind: 'git', repo: 'grp/proj', payload: { checkout_sha: 'cs1' } }, run: RUN }, replies: [{ status: 201, json: {} }] },
  { op: 'gitlab.setCommitStatus', config: GITLAB, params: { project: 'grp/proj', sha: 'x', state: 'weird' }, replies: [] },
  { op: 'gitlab.setCommitStatus', config: GITLAB, params: { project: 'grp/proj', sha: 'x', state: 'success', name: 'n' }, replies: [{ status: 403, text: '' }] },
  { op: 'gitlab.commentMR', config: GITLAB, params: { mr: '!4', body: 'Nice' }, ctx: { event: { kind: 'git', payload: { project: { path_with_namespace: 'g/p' } } } }, replies: [{ status: 201, json: {} }] },
  { op: 'discord.postMessage', config: DISCORD, params: { channel: '123', text: 'hi' }, replies: [{ json: {} }] },
  { op: 'discord.postMessage', config: DISCORD, params: { channel: '123', text: 'hi' }, replies: [{ status: 429, text: 'slow   down\n now' }] },
  { op: 'teams.postMessage', config: TEAMS, params: { text: 'Ship' }, replies: [{ json: {} }] },
  { op: 'teams.postMessage', config: { kind: 'teams', connected: true, settings: { webhookUrl: 'https://evil.com' } }, params: { text: 'x' }, replies: [] },
  { op: 'teams.postMessage', config: { kind: 'teams', connected: true }, params: { text: 'x' }, replies: [] },
  { op: 'webhook.post', params: { url: 'https://hooks.example.com/a/b?x=1', body: '{"a":1}' }, replies: [{ status: 202 }] },
  { op: 'webhook.post', params: { url: 'https://hooks.example.com', body: 'text', contentType: 'text/plain' }, replies: [{ status: 200 }] },
  { op: 'webhook.post', params: { url: 'http://hooks.example.com', body: 'x' }, replies: [] },
  { op: 'webhook.post', params: { url: 'nope', body: 'x' }, replies: [] },
  { op: 'webhook.post', params: { url: 'https://h.example.com', body: 'x' }, replies: [{ status: 500, text: 'down' }] },
  { op: 'webhook.post', params: { url: 'https://h.example.com', body: 'x' }, replies: [] },
  { op: 'nope.nothing', params: {}, replies: [] },
];

it('connectors and workflow actions send and return what the TS code does', async () => {
  const fetches = [];
  for (const c of FETCHES) {
    fetches.push({ ...c, ...(await recorded(c.replies, () => getConnector(c.kind).fetch(c.token, c.query, c.settings))) });
  }
  const polls = [];
  for (const c of POLLS) {
    polls.push({ ...c, ...(await recorded(c.replies, () => getConnector(c.kind).poll!(c.token, c.settings, c.cursor))) });
  }
  const actions = [];
  for (const c of ACTIONS) {
    actions.push({ ...c, ...(await recorded(c.replies, () => runWorkflowAction(c.op, c.config, c.params, (c.ctx ?? {}) as never))) });
  }

  const tctx = templateContext({
    event: { kind: 'git', provider: 'github', repo: 'o/r', branch: 'main', payload: { sha: 'abc', n: 5, obj: { a: [1, 2] }, nul: null, flag: false } } as never,
    outputs: new Map([['build', 'ok\nlines'], ['test', '']]),
    run: RUN,
  });
  const templates = [
    'plain', '{{trigger.repo}}@{{trigger.sha}}', '{{ trigger.branch }}', '{{trigger.missing}}', '{{trigger.obj}}', '{{trigger.obj.a}}',
    '{{trigger.n}} {{trigger.flag}} {{trigger.nul}}', '{{steps.build.output}}', '{{steps.test.output}}', '{{steps.none.output}}',
    '{{run.workflowName}} {{run.status}}', '{{unknown.x}}', '{{trigger}}', '{ {trigger.repo} }', '{{trigger.repo.length}}',
    '{{trigger.obj.a.0}}', '{{ bad path! }}', '{{trigger.kind}}{{trigger.kind}}',
  ].map((t) => ({ template: t, rendered: renderTemplate(t, tctx) }));

  check(join(crate, 'tests', 'golden', 'connectors.json'), { fetches, polls, actions, templateContext: tctx, templates });
});
