import type { ConnectorKind, ConnectorResource } from '@nekko-agent/shared';

/** One event returned by a connector poll; listeners map these to WorkflowEvents. */
export interface ConnectorPollEvent {
  /** A stable, per-connector id used for deduplication. */
  id: string;
  /** Cursor value (epoch ms) for this event; the listener advances to the max. */
  cursor: number;
  /** Event type, e.g. 'message' or 'issue'. */
  event: string;
  /** Human-readable text/label for the run log. */
  text?: string;
  /** Where the event came from (Slack channel, repo, etc.). */
  source?: string;
  /** Free-form payload for templates and context. */
  payload?: Record<string, unknown>;
}

export interface ConnectorPollResult {
  events: ConnectorPollEvent[];
  /** The next cursor to start from (usually the max event cursor). */
  nextCursor: number;
}

export interface Connector {
  readonly kind: ConnectorKind;
  /** Fetch resources (optionally filtered by a query) to surface in context. */
  fetch(token: string, query?: string, settings?: Record<string, string>): Promise<ConnectorResource[]>;
  /** Poll for new events since `cursor` (epoch ms). Optional — not every connector supports triggered reads. */
  poll?(token: string, settings: Record<string, string>, cursor: number): Promise<ConnectorPollResult>;
}

/** GitHub, REST API, authenticated with a personal access token. Lists the
 *  user's most recently updated repos, or searches issues and PRs by query. */
export const githubConnector: Connector = {
  kind: 'github',
  async fetch(token, query) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nekko-agent',
    };
    if (query) {
      const res = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=20`,
        { headers },
      );
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const json: any = await res.json();
      return (json.items ?? []).map((it: any) => ({
        id: String(it.id),
        title: it.title,
        subtitle: `${it.pull_request ? 'PR' : 'Issue'} ${it.repository_url?.split('/').slice(-2).join('/') ?? ''} #${it.number}`,
        url: it.html_url,
        body: it.body ?? '',
      }));
    }
    const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=25', { headers });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const repos = (await res.json()) as any[];
    return repos.map((r) => ({
      id: String(r.id),
      title: r.full_name,
      subtitle: r.private ? 'private repo' : 'repo',
      url: r.html_url,
      body: r.description ?? '',
    }));
  },
  async poll(token, settings, cursor) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nekko-agent',
    };
    const repo = (settings.repo ?? '').trim();
    const since = new Date(cursor).toISOString();
    let url: string;
    if (repo) {
      url = `https://api.github.com/repos/${encodeURIComponent(repo)}/events?per_page=25`;
    } else {
      url = `https://api.github.com/events?per_page=25`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const eventsData: any[] = (await res.json()) as any[];
    const wantEvent = (settings.event ?? '').toLowerCase();
    const filter = (settings.filter ?? '').toLowerCase();
    const events: ConnectorPollEvent[] = [];
    for (const ev of eventsData) {
      const createdAt = new Date(ev.created_at).getTime();
      if (createdAt <= cursor) continue;
      const eventType = (ev.type ?? '').toLowerCase();
      if (wantEvent && !eventType.includes(wantEvent)) continue;
      const text = `${ev.type ?? 'event'}${ev.payload?.number ? ` #${ev.payload.number}` : ''}${ev.payload?.action ? ` ${ev.payload.action}` : ''}`.trim();
      const json = JSON.stringify(ev.payload ?? {});
      if (filter && !text.toLowerCase().includes(filter) && !json.toLowerCase().includes(filter)) continue;
      events.push({
        id: String(ev.id),
        cursor: createdAt,
        event: ev.type ?? 'event',
        text,
        source: ev.repo?.name ?? repo,
        payload: ev.payload ?? {},
      });
    }
    const nextCursor = events.length ? Math.max(...events.map((e) => e.cursor)) : cursor;
    return { events, nextCursor };
  },
};

/** Linear, GraphQL API, authenticated with a personal API key. */
export const linearConnector: Connector = {
  kind: 'linear',
  async fetch(token, query) {
    const gql = query
      ? { query: `query($q:String!){ searchIssues(term:$q){ nodes{ id identifier title url description } } }`, variables: { q: query } }
      : { query: `{ issues(first:25, orderBy:updatedAt){ nodes{ id identifier title url description } } }` };
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(gql),
    });
    if (!res.ok) throw new Error(`Linear ${res.status}`);
    const json: any = await res.json();
    const nodes = json.data?.issues?.nodes ?? json.data?.searchIssues?.nodes ?? [];
    return nodes.map((n: any) => ({
      id: n.id,
      title: `${n.identifier} ${n.title}`,
      subtitle: 'Linear issue',
      url: n.url,
      body: n.description ?? '',
    }));
  },
  async poll(token, _settings, cursor) {
    const since = new Date(cursor).toISOString();
    const filter = `{ updatedAt: { gt: "${since}" } }`;
    const query = `{ issues(first: 25, filter: ${filter}, orderBy: updatedAt) { nodes { id identifier title url description updatedAt state { name } } } }`;
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Linear ${res.status}`);
    const json: any = await res.json();
    const nodes = json.data?.issues?.nodes ?? [];
    const events: ConnectorPollEvent[] = [];
    for (const n of nodes) {
      const updatedAt = new Date(n.updatedAt).getTime();
      if (updatedAt <= cursor) continue;
      events.push({
        id: `${n.id}:${n.updatedAt}`,
        cursor: updatedAt,
        event: 'issue',
        text: `${n.identifier} ${n.title}`.trim(),
        payload: { ...n, updatedAt },
      });
    }
    const nextCursor = events.length ? Math.max(...events.map((e) => e.cursor)) : cursor;
    return { events, nextCursor };
  },
};

/** Slack, Web API, token-based. Lists channels or searches messages. */
export const slackConnector: Connector = {
  kind: 'slack',
  async fetch(token, query) {
    const url = query
      ? `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=20`
      : `https://slack.com/api/conversations.list?limit=50&exclude_archived=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Slack: ${json.error ?? 'error'}`);
    if (query) {
      return (json.messages?.matches ?? []).map((m: any) => ({
        id: m.iid ?? m.ts,
        title: m.text?.slice(0, 80) ?? '(message)',
        subtitle: `#${m.channel?.name ?? ''}`,
        url: m.permalink,
        body: m.text ?? '',
      }));
    }
    return (json.channels ?? []).map((c: any) => ({
      id: c.id,
      title: `#${c.name}`,
      subtitle: c.is_private ? 'private channel' : 'channel',
      body: c.purpose?.value ?? '',
    }));
  },
  async poll(token, settings, cursor) {
    const want = (settings.channel ?? '').trim();
    if (!want) throw new Error('Slack poll needs a channel id or #channel name in the trigger.');
    let channelId = want.replace(/^#/, '');
    if (want.startsWith('#')) {
      const listRes = await fetch('https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=public_channel,private_channel', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const list: any = await listRes.json();
      if (!list.ok) throw new Error(`Slack: ${list.error ?? 'error'}`);
      const found = list.channels?.find((c: any) => c.name === channelId);
      if (!found) throw new Error(`Slack channel "${want}" not found.`);
      channelId = found.id;
    }
    const oldest = cursor > 0 ? String(cursor / 1000) : undefined;
    const qs = new URLSearchParams({ channel: channelId, limit: '50' });
    if (oldest) qs.set('oldest', oldest);
    const res = await fetch(`https://slack.com/api/conversations.history?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Slack: ${json.error ?? 'error'}`);
    const filter = (settings.filter ?? '').toLowerCase();
    const messages = (json.messages ?? []).filter((m: any) => !m.subtype);
    const events: ConnectorPollEvent[] = [];
    for (const m of messages) {
      const text = m.text ?? '';
      if (filter && !text.toLowerCase().includes(filter)) continue;
      const tsMs = Math.round(Number(m.ts) * 1000);
      if (tsMs <= cursor) continue;
      events.push({
        id: `${channelId}:${m.ts}`,
        cursor: tsMs,
        event: 'message',
        text: text.slice(0, 140),
        source: want,
        payload: { ...m, channel: channelId },
      });
    }
    const nextCursor = events.length ? Math.max(...events.map((e) => e.cursor)) : cursor;
    return { events: events.reverse(), nextCursor };
  },
};

/** Discord, bot token. Lists the bot's guilds. */
export const discordConnector: Connector = {
  kind: 'discord',
  async fetch(token) {
    const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    const guilds = (await res.json()) as any[];
    return guilds.map((g) => ({ id: g.id, title: g.name, subtitle: 'Discord server', body: '' }));
  },
};

/**
 * Resolve a GitLab API base URL from connector settings. `site` points at a
 * self-managed instance; empty means gitlab.com. Shared by the connector and
 * the workflow action runners (see ./actions.ts).
 */
export function gitlabBase(settings?: Record<string, string>): string {
  const site = (settings?.site ?? '').trim().replace(/\/+$/, '') || 'https://gitlab.com';
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    throw new Error(`GitLab site "${site}" isn't a valid URL.`);
  }
  if (u.protocol !== 'https:') throw new Error('The GitLab instance URL must be https.');
  if (u.pathname.replace(/\/+$/, '') !== '') {
    throw new Error(`The GitLab instance URL should be the instance origin (e.g. https://gitlab.example.com), not "${site}".`);
  }
  return u.origin;
}

/** GitLab REST v4, personal access token (PRIVATE-TOKEN header). Lists the
 *  projects the token can see, or searches them by name. */
export const gitlabConnector: Connector = {
  kind: 'gitlab',
  async fetch(token, query, settings) {
    const base = gitlabBase(settings);
    const qs = `membership=true&order_by=updated_at&per_page=25${query ? `&search=${encodeURIComponent(query)}` : ''}`;
    const res = await fetch(`${base}/api/v4/projects?${qs}`, {
      headers: { 'PRIVATE-TOKEN': token },
    });
    if (!res.ok) throw new Error(`GitLab ${res.status}`);
    const projects = (await res.json()) as any[];
    return projects.map((p) => ({
      id: String(p.id),
      title: p.path_with_namespace,
      subtitle: 'GitLab project',
      url: p.web_url,
      body: p.description ?? '',
    }));
  },
  async poll(token, settings, cursor) {
    const base = gitlabBase(settings);
    const project = (settings.repo ?? settings.project ?? '').trim();
    const after = new Date(cursor).toISOString().slice(0, 10);
    let url: string;
    if (project) {
      const enc = encodeURIComponent(project);
      url = `${base}/api/v4/projects/${enc}/events?per_page=25&after=${after}`;
    } else {
      url = `${base}/api/v4/events?per_page=25&after=${after}`;
    }
    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token } });
    if (!res.ok) throw new Error(`GitLab ${res.status}`);
    const data: any[] = (await res.json()) as any[];
    const wantEvent = (settings.event ?? '').toLowerCase();
    const filter = (settings.filter ?? '').toLowerCase();
    const events: ConnectorPollEvent[] = [];
    for (const ev of data) {
      const createdAt = new Date(ev.created_at).getTime();
      if (createdAt <= cursor) continue;
      const eventType = (ev.action_name ?? ev.target_type ?? 'event').toLowerCase();
      if (wantEvent && !eventType.includes(wantEvent)) continue;
      const text = `${ev.target_title ?? ev.title ?? eventType}${ev.target_iid ? ` #${ev.target_iid}` : ''}`.trim();
      const json = JSON.stringify(ev);
      if (filter && !text.toLowerCase().includes(filter) && !json.toLowerCase().includes(filter)) continue;
      events.push({
        id: `${ev.project_id ?? ev.id}:${ev.created_at}`,
        cursor: createdAt,
        event: ev.action_name ?? ev.target_type ?? 'event',
        text,
        source: ev.project_id ? String(ev.project_id) : project,
        payload: ev,
      });
    }
    const nextCursor = events.length ? Math.max(...events.map((e) => e.cursor)) : cursor;
    return { events, nextCursor };
  },
};

/**
 * Jira Cloud REST, Basic auth (email + API token). The site URL and email ride
 * in `settings` (`site`, `email`) since the connector contract has a single
 * token slot; the token is the API token from id.atlassian.com.
 *
 * The current JQL search endpoint is `/rest/api/3/search/jql`; the legacy
 * `GET /rest/api/3/search` was removed from Jira Cloud in 2025, but we retry it
 * on 404/410 for sites that still route the old path.
 */
export const jiraConnector: Connector = {
  kind: 'jira',
  async fetch(token, query, settings) {
    const site = (settings?.site ?? '').trim().replace(/\/+$/, '');
    const email = (settings?.email ?? '').trim();
    if (!site || !email) throw new Error('Jira needs a site URL and the account email.');
    let siteUrl: URL;
    try {
      siteUrl = new URL(site);
    } catch {
      throw new Error(`Jira site "${site}" isn't a valid URL.`);
    }
    if (siteUrl.protocol !== 'https:') throw new Error('Jira site URL must be https.');
    const headers = {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
    };
    // JQL reserves a swath of punctuation that can't appear inside a quoted
    // phrase (`+ - = & | > < ! ( ) { } [ ] ^ " ~ * ? : \ /`), so the term is
    // folded to plain words rather than escaped: this stays a fuzzy text
    // search, never a query-language injection point.
    const term = (query ?? '')
      .replace(/["\\]/g, ' ')
      .replace(/[+\-=&|><!(){}\[\]^~*?:/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const jql = term ? `text ~ "${term}" order by updated desc` : 'order by updated desc';
    const qs = `jql=${encodeURIComponent(jql)}&maxResults=25&fields=summary,status,issuetype,description`;
    let res = await fetch(`${site}/rest/api/3/search/jql?${qs}`, { headers });
    if (res.status === 404 || res.status === 410) {
      res = await fetch(`${site}/rest/api/3/search?${qs}`, { headers });
    }
    if (!res.ok) throw new Error(`Jira ${res.status}`);
    const json: any = await res.json();
    return (json.issues ?? []).map((issue: any) => ({
      id: String(issue.id ?? issue.key),
      title: `${issue.key} ${issue.fields?.summary ?? ''}`.trim(),
      subtitle: [issue.fields?.issuetype?.name, issue.fields?.status?.name].filter(Boolean).join(' · ') || 'Jira issue',
      url: `${site}/browse/${issue.key}`,
      body: typeof issue.fields?.description === 'string' ? issue.fields.description : '',
    }));
  },
  async poll(token, settings, cursor) {
    const site = (settings?.site ?? '').trim().replace(/\/+$/, '');
    const email = (settings?.email ?? '').trim();
    if (!site || !email) throw new Error('Jira needs a site URL and the account email.');
    const jqlDate = new Date(cursor).toISOString().replace('T', ' ').slice(0, 16);
    const jql = `updated >= "${jqlDate}" order by updated desc`;
    const qs = `jql=${encodeURIComponent(jql)}&maxResults=25&fields=summary,status,issuetype,description,updated`;
    const headers = {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
    };
    let res = await fetch(`${site}/rest/api/3/search/jql?${qs}`, { headers });
    if (res.status === 404 || res.status === 410) {
      res = await fetch(`${site}/rest/api/3/search?${qs}`, { headers });
    }
    if (!res.ok) throw new Error(`Jira ${res.status}`);
    const json: any = await res.json();
    const filter = (settings.filter ?? '').toLowerCase();
    const events: ConnectorPollEvent[] = [];
    for (const issue of json.issues ?? []) {
      const updated = new Date(issue.fields?.updated).getTime();
      if (!updated || updated <= cursor) continue;
      const text = `${issue.key} ${issue.fields?.summary ?? ''}`.trim();
      if (filter && !text.toLowerCase().includes(filter) && !(issue.fields?.description ?? '').toLowerCase().includes(filter)) continue;
      events.push({
        id: `${issue.key}:${issue.fields?.updated}`,
        cursor: updated,
        event: 'issue',
        text,
        payload: { ...issue.fields, key: issue.key, updated },
      });
    }
    const nextCursor = events.length ? Math.max(...events.map((e) => e.cursor)) : cursor;
    return { events, nextCursor };
  },
};

/**
 * Microsoft Teams, v1. Posting goes through an incoming webhook URL
 * (`settings.webhookUrl`); reads use a pasted Microsoft Graph token. Full Graph
 * OAuth is deferred because it needs an app registration.
 *
 * The webhook is only URL-checked here: `fetch` is also "Fetch sample" in the
 * UI, so it must never post to the channel.
 */
export const teamsConnector: Connector = {
  kind: 'teams',
  async fetch(token, query, settings) {
    if (token) {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/joinedTeams', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Graph ${res.status}`);
      const json: any = await res.json();
      let teams = (json.value ?? []).map((t: any) => ({
        id: t.id,
        title: t.displayName ?? 'Team',
        subtitle: 'Microsoft Teams',
        body: t.description ?? '',
      }));
      if (query) {
        const q = query.toLowerCase();
        teams = teams.filter((t: ConnectorResource) => t.title.toLowerCase().includes(q));
      }
      return teams;
    }
    const webhook = (settings?.webhookUrl ?? '').trim();
    if (webhook) {
      let u: URL;
      try {
        u = new URL(webhook);
      } catch {
        throw new Error("The Teams webhook URL isn't a valid https URL.");
      }
      // A webhook URL is a stored credential that gets POSTed to, so it has to
      // be a real Teams incoming webhook, not just any https URL: https on the
      // *.webhook.office.com host that Teams hands out for channel connectors.
      const host = u.hostname.toLowerCase();
      if (
        u.protocol !== 'https:' ||
        (host !== 'webhook.office.com' && !host.endsWith('.webhook.office.com'))
      ) {
        throw new Error(
          "The Teams webhook URL must be an https URL on *.webhook.office.com (the Incoming Webhook URL from the Teams channel).",
        );
      }
      return [
        {
          id: 'webhook',
          title: 'Incoming webhook',
          subtitle: host,
          body: 'Nekko Agent can post messages to this channel. Add a Graph token to read teams.',
        },
      ];
    }
    throw new Error('Teams needs an incoming webhook URL or a Microsoft Graph token.');
  },
};

/** Gmail / Drive use Google OAuth; wired once the OAuth flow lands in main. */
export const gmailConnector: Connector = {
  kind: 'gmail',
  async fetch(token, query) {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Gmail ${res.status}, connect via OAuth`);
    const json: any = await res.json();
    return (json.messages ?? []).map((m: any) => ({ id: m.id, title: `Message ${m.id}`, subtitle: 'Gmail', body: '' }));
  },
};

export const gdriveConnector: Connector = {
  kind: 'gdrive',
  async fetch(token, query) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?pageSize=20${query ? `&q=${encodeURIComponent(`name contains '${query}'`)}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Drive ${res.status}, connect via OAuth`);
    const json: any = await res.json();
    return (json.files ?? []).map((f: any) => ({ id: f.id, title: f.name, subtitle: f.mimeType, body: '' }));
  },
};

/** Narrow a fetched list to resources whose title or body mentions `query`. */
function matching(items: ConnectorResource[], query?: string): ConnectorResource[] {
  const q = (query ?? '').trim().toLowerCase();
  return q ? items.filter((i) => `${i.title}\n${i.body ?? ''}`.toLowerCase().includes(q)) : items;
}

/** Trello, REST API. Needs the API key (settings.key) and a user token. Lists the user's open cards. */
export const trelloConnector: Connector = {
  kind: 'trello',
  async fetch(token, query, settings) {
    const key = (settings?.key ?? '').trim();
    if (!key) throw new Error('Trello needs the API key as well as the token.');
    const auth = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(`https://api.trello.com/1/members/me/cards?filter=open&fields=name,desc,shortUrl,due,dateLastActivity&${auth}`);
    if (!res.ok) throw new Error(`Trello ${res.status}`);
    const cards = (await res.json()) as any[];
    return matching(cards.map((c) => ({
      id: String(c.id),
      title: c.name ?? '',
      subtitle: c.due ? `Trello card · due ${String(c.due).slice(0, 10)}` : 'Trello card',
      url: c.shortUrl,
      body: c.desc ?? '',
    })), query);
  },
};

/** Asana, REST API with a personal access token. Lists the user's incomplete tasks in a workspace. */
export const asanaConnector: Connector = {
  kind: 'asana',
  async fetch(token, query, settings) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let workspace = (settings?.workspace ?? '').trim();
    if (!workspace) {
      const me = await fetch('https://app.asana.com/api/1.0/users/me', { headers });
      if (!me.ok) throw new Error(`Asana ${me.status}`);
      workspace = (await me.json() as any).data?.workspaces?.[0]?.gid ?? '';
      if (!workspace) throw new Error('Asana account has no workspace.');
    }
    const qs = `assignee=me&workspace=${encodeURIComponent(workspace)}&completed_since=now&limit=50&opt_fields=name,notes,permalink_url,due_on`;
    const res = await fetch(`https://app.asana.com/api/1.0/tasks?${qs}`, { headers });
    if (!res.ok) throw new Error(`Asana ${res.status}`);
    const json: any = await res.json();
    return matching((json.data ?? []).map((t: any) => ({
      id: String(t.gid),
      title: t.name ?? '',
      subtitle: t.due_on ? `Asana task · due ${t.due_on}` : 'Asana task',
      url: t.permalink_url,
      body: t.notes ?? '',
    })), query);
  },
};

/** Todoist, unified API v1 with an API token. Lists active tasks. */
export const todoistConnector: Connector = {
  kind: 'todoist',
  async fetch(token, query) {
    const res = await fetch('https://api.todoist.com/api/v1/tasks?limit=100', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Todoist ${res.status}`);
    const json: any = await res.json();
    const tasks: any[] = Array.isArray(json) ? json : json.results ?? [];
    return matching(tasks.map((t) => ({
      id: String(t.id),
      title: t.content ?? '',
      subtitle: t.due?.date ? `Todoist · due ${t.due.date}` : 'Todoist task',
      url: t.url ?? `https://app.todoist.com/app/task/${t.id}`,
      body: t.description ?? '',
    })), query);
  },
};

/** ClickUp, API v2 with a personal token (sent bare, no Bearer). Lists open tasks in a workspace. */
export const clickupConnector: Connector = {
  kind: 'clickup',
  async fetch(token, query, settings) {
    const headers = { Authorization: token, Accept: 'application/json' };
    let team = (settings?.team ?? '').trim();
    if (!team) {
      const res = await fetch('https://api.clickup.com/api/v2/team', { headers });
      if (!res.ok) throw new Error(`ClickUp ${res.status}`);
      team = String((await res.json() as any).teams?.[0]?.id ?? '');
      if (!team) throw new Error('ClickUp account has no workspace.');
    }
    const res = await fetch(`https://api.clickup.com/api/v2/team/${encodeURIComponent(team)}/task?order_by=updated&subtasks=true`, { headers });
    if (!res.ok) throw new Error(`ClickUp ${res.status}`);
    const json: any = await res.json();
    return matching((json.tasks ?? []).map((t: any) => ({
      id: String(t.id),
      title: t.name ?? '',
      subtitle: ['ClickUp', t.status?.status].filter(Boolean).join(' · '),
      url: t.url,
      body: t.description ?? '',
    })), query);
  },
};

/**
 * Parse a Markdown checklist into tasks: each `- [ ]` / `* [ ]` line is an open
 * task, `[x]` lines are done and skipped. The nearest heading above becomes the
 * subtitle so a TASKS.md grouped by section reads the same in the panel.
 */
export function parseTasksMarkdown(text: string, path = ''): ConnectorResource[] {
  const out: ConnectorResource[] = [];
  let section = '';
  text.split(/\r?\n/).forEach((line, i) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { section = heading[1].trim(); return; }
    const task = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!task || task[1] !== ' ') return;
    out.push({ id: `${path}:${i + 1}`, title: task[2].trim(), subtitle: section || 'Tasks file', url: path ? `file://${path}` : undefined, body: '' });
  });
  return out;
}

/** A local Markdown task file (settings.path). Read on the host; no account. */
export const tasksFileConnector: Connector = {
  kind: 'tasksfile',
  async fetch(_token, query, settings) {
    const path = (settings?.path ?? '').trim();
    if (!path) throw new Error('Pick the Markdown file that holds your tasks.');
    const { readFile } = await import('node:fs/promises');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new Error(`Couldn't read ${path}.`);
    }
    return matching(parseTasksMarkdown(text, path), query);
  },
};

export const CONNECTORS: Record<ConnectorKind, Connector> = {
  github: githubConnector,
  gitlab: gitlabConnector,
  linear: linearConnector,
  slack: slackConnector,
  discord: discordConnector,
  jira: jiraConnector,
  teams: teamsConnector,
  gmail: gmailConnector,
  gdrive: gdriveConnector,
  trello: trelloConnector,
  asana: asanaConnector,
  todoist: todoistConnector,
  clickup: clickupConnector,
  tasksfile: tasksFileConnector,
};

export function getConnector(kind: ConnectorKind): Connector {
  return CONNECTORS[kind];
}
