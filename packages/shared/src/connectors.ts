/** External connector types: GitHub, GitLab, Linear, Slack, Discord, Jira, Microsoft Teams, Gmail, Google Drive. */

export type ConnectorKind =
  | 'github' | 'gitlab' | 'linear' | 'slack' | 'discord' | 'jira' | 'teams' | 'gmail' | 'gdrive'
  | 'trello' | 'asana' | 'todoist' | 'clickup' | 'tasksfile';

export type ConnectorAuthKind = 'token' | 'oauth';

export interface ConnectorMeta {
  kind: ConnectorKind;
  label: string;
  auth: ConnectorAuthKind;
  /** Short description shown in the Connectors UI. */
  description: string;
  /** Task-management systems feed the Agent Monitor's Tasks section. */
  category?: 'tasks';
}

export interface ConnectorConfig {
  kind: ConnectorKind;
  connected: boolean;
  /** Token-based connectors store a token; oauth stores tokens elsewhere. */
  token?: string;
  /** Free-form per-connector settings (workspace id, channel, etc.). */
  settings?: Record<string, string>;
  connectedAt?: number;
}

export interface ConnectorResource {
  id: string;
  title: string;
  subtitle?: string;
  url?: string;
  /** Body that can be pulled into context. */
  body?: string;
}

export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  { kind: 'github', label: 'GitHub', auth: 'token', description: 'Repositories, issues, and pull requests via a personal access token.' },
  { kind: 'gitlab', label: 'GitLab', auth: 'token', description: 'Projects, merge requests, and commit statuses via a personal access token (gitlab.com or self-managed).' },
  { kind: 'linear', label: 'Linear', auth: 'token', category: 'tasks', description: 'Issues, projects, and cycles via Linear API key.' },
  { kind: 'slack', label: 'Slack', auth: 'token', description: 'Channels and messages via a bot/user token.' },
  { kind: 'discord', label: 'Discord', auth: 'token', description: 'Servers and channels via a bot token.' },
  { kind: 'jira', label: 'Jira', auth: 'token', category: 'tasks', description: 'Issues and JQL search via Jira Cloud REST (site URL + email + API token).' },
  { kind: 'teams', label: 'Microsoft Teams', auth: 'token', description: 'Post to a channel via an incoming webhook; read teams with a Microsoft Graph token.' },
  { kind: 'gmail', label: 'Gmail', auth: 'oauth', description: 'Threads and messages via Google OAuth.' },
  { kind: 'gdrive', label: 'Google Drive', auth: 'oauth', description: 'Docs and files via Google OAuth.' },
  { kind: 'trello', label: 'Trello', auth: 'token', category: 'tasks', description: 'Your open cards across boards via a Trello API key and token.' },
  { kind: 'asana', label: 'Asana', auth: 'token', category: 'tasks', description: 'Your incomplete tasks via an Asana personal access token.' },
  { kind: 'todoist', label: 'Todoist', auth: 'token', category: 'tasks', description: 'Active tasks via a Todoist API token.' },
  { kind: 'clickup', label: 'ClickUp', auth: 'token', category: 'tasks', description: 'Open tasks in a workspace via a ClickUp personal API token.' },
  { kind: 'tasksfile', label: 'Tasks file', auth: 'token', category: 'tasks', description: 'A local Markdown checklist (TASKS.md, todo.md): every "- [ ]" line is a task. No account needed.' },
];

/** Connector kinds that are task-management systems. */
export function isTaskConnector(kind: ConnectorKind): boolean {
  return CONNECTOR_CATALOG.some((c) => c.kind === kind && c.category === 'tasks');
}
