/** External connector types: GitHub, GitLab, Linear, Slack, Discord, Jira, Microsoft Teams, Gmail, Google Drive. */

export type ConnectorKind =
  | 'github' | 'gitlab' | 'linear' | 'slack' | 'discord' | 'jira' | 'teams' | 'gmail' | 'gdrive'
  | 'trello' | 'asana' | 'todoist' | 'clickup' | 'tasksfile' | 'floop';

export type ConnectorAuthKind = 'token' | 'oauth';

export interface ConnectorMeta {
  kind: ConnectorKind;
  label: string;
  auth: ConnectorAuthKind;
  /** Short description shown in the Connectors UI. */
  description: string;
  /** Where the Connectors page lists it. Project management feeds the Agent Monitor's Tasks section. */
  group: ConnectorGroup;
  /** A Nekko Labs product: the Connectors page marks it "Nekko Labs". Set by hand, never inferred from the name. */
  nekkoLabs?: boolean;
}

/** A heading on the Connectors page (`CONNECTOR_GROUPS` holds the order and labels). */
export type ConnectorGroup = 'git' | 'projects' | 'chat' | 'docs';

export interface ConnectorConfig {
  kind: ConnectorKind;
  connected: boolean;
  /** Token-based connectors store a token; oauth stores tokens elsewhere. */
  token?: string;
  /** Free-form per-connector settings (workspace id, channel, etc.); a git connector's `RepoExclusions` too. */
  settings?: Record<string, string | string[]>;
  connectedAt?: number;
}

/**
 * What a GitHub or GitLab connector leaves out of Add repository and chat
 * context (#2562), as lower-case `owner/name` and owner names. Lists of what
 * is removed, so new repositories show up by default and a removed owner's
 * new ones stay out. The token's own access is unchanged.
 */
export interface RepoExclusions {
  excludedRepos: string[];
  excludedOwners: string[];
}

/** A sign-in found on this computer that a connector can use (`connectors:detect`). */
export interface DetectedSignIn {
  /** Where it came from: the GitHub CLI. */
  source: 'gh';
  /** The account it belongs to, or "" when the service did not say. */
  account: string;
}

export type DetectedConnectors = Partial<Record<ConnectorKind, DetectedSignIn>>;

export interface ConnectorResource {
  id: string;
  title: string;
  subtitle?: string;
  url?: string;
  /** Body that can be pulled into context. */
  body?: string;
}

export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  { kind: 'github', label: 'GitHub', auth: 'token', group: 'git', description: 'Repositories, issues, and pull requests via a personal access token.' },
  { kind: 'gitlab', label: 'GitLab', auth: 'token', group: 'git', description: 'Projects, merge requests, and commit statuses via a personal access token (gitlab.com or self-managed).' },
  { kind: 'linear', label: 'Linear', auth: 'token', group: 'projects', description: 'Issues, projects, and cycles via Linear API key.' },
  { kind: 'slack', label: 'Slack', auth: 'token', group: 'chat', description: 'Channels and messages via a bot/user token.' },
  { kind: 'discord', label: 'Discord', auth: 'token', group: 'chat', description: 'Servers and channels via a bot token.' },
  { kind: 'jira', label: 'Jira', auth: 'token', group: 'projects', description: 'Issues and JQL search via Jira Cloud REST (site URL + email + API token).' },
  { kind: 'teams', label: 'Microsoft Teams', auth: 'token', group: 'chat', description: 'Post to a channel via an incoming webhook; read teams with a Microsoft Graph token.' },
  { kind: 'gmail', label: 'Gmail', auth: 'oauth', group: 'chat', description: 'Threads and messages via Google OAuth.' },
  { kind: 'gdrive', label: 'Google Drive', auth: 'oauth', group: 'docs', description: 'Docs and files via Google OAuth.' },
  { kind: 'trello', label: 'Trello', auth: 'token', group: 'projects', description: 'Your open cards across boards via a Trello API key and token.' },
  { kind: 'asana', label: 'Asana', auth: 'token', group: 'projects', description: 'Your incomplete tasks via an Asana personal access token.' },
  { kind: 'todoist', label: 'Todoist', auth: 'token', group: 'projects', description: 'Active tasks via a Todoist API token.' },
  { kind: 'clickup', label: 'ClickUp', auth: 'token', group: 'projects', description: 'Open tasks in a workspace via a ClickUp personal API token.' },
  { kind: 'tasksfile', label: 'Tasks file', auth: 'token', group: 'projects', description: 'A local Markdown checklist (TASKS.md, todo.md): every "- [ ]" line is a task. No account needed.' },
  { kind: 'floop', label: 'Floop', auth: 'token', group: 'projects', nekkoLabs: true, description: "Your open tasks on your team's Floop server, where people and agents track work in separate streams (server URL + API token)." },
];

/** Connector kinds that are task-management systems. */
export function isTaskConnector(kind: ConnectorKind): boolean {
  return CONNECTOR_CATALOG.some((c) => c.kind === kind && c.group === 'projects');
}

/** The catalog's groups, in the order the Connectors page shows them. */
export const CONNECTOR_GROUPS: { id: ConnectorGroup; label: string }[] = [
  { id: 'git', label: 'Git providers' },
  { id: 'projects', label: 'Project management' },
  { id: 'chat', label: 'Chat and email' },
  { id: 'docs', label: 'Docs and files' },
];
