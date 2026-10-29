/**
 * Settings > Connections (#1034): every connection Nekko Agent makes or
 * accepts, with one switch for all of them and one per row. The engine
 * enforces both (crates/nekko-net); this list names them. The ids match
 * `nekko_net::IDS`, which a Rust test checks against this file.
 */

/** `AppSettings.connections`. */
export interface ConnectionSettings {
  /** All connections off: nothing reaches or leaves this computer over the network; every chat runs Offline. */
  allOff?: boolean;
  /** Connection ids switched off, loopback included. */
  blocked?: string[];
}

export type ConnectionGroup = 'background' | 'listener' | 'onDemand';

export interface ConnectionInfo {
  id: string;
  label: string;
  group: ConnectionGroup;
  /** Where it goes (outbound) or who can reach it (inbound). */
  where: string;
  /** What it is for, and when it happens. */
  desc: string;
}

export const CONNECTION_GROUPS: { id: ConnectionGroup; label: string; desc: string }[] = [
  { id: 'background', label: 'In the background', desc: 'Contact the app makes on its own, on a timer or at startup.' },
  { id: 'listener', label: 'Incoming', desc: 'Ways other devices can reach this computer.' },
  { id: 'onDemand', label: 'When you or an agent asks', desc: 'Contact made only when you click something or an agent uses a tool.' },
];

export const CONNECTIONS: ConnectionInfo[] = [
  { id: 'updates', label: 'App updates', group: 'background', where: 'github.com', desc: 'Looks for a new version at startup when App updates is on, and downloads it.' },
  { id: 'model-lists', label: 'Provider model lists', group: 'background', where: 'Your model providers', desc: 'Re-reads each provider’s model list every 6 hours.' },
  { id: 'skills-catalog', label: 'Skills catalog', group: 'background', where: 'raw.githubusercontent.com', desc: 'Refreshes the skills marketplace every 6 hours when switched on.' },
  { id: 'cloud-sync', label: 'Nekko Cloud', group: 'background', where: 'nekko-agent-api.fly.dev', desc: 'Your account and end-to-end encrypted sync, every minute while sync is on.' },
  { id: 'phone-relay', label: 'Phone relay', group: 'background', where: 'nekko-agent-relay.fly.dev or your relay', desc: 'Keeps a connection open to the relay while remote access is on, so your phone can reach this computer.' },
  { id: 'limits', label: 'Plan and limit checks', group: 'background', where: 'chatgpt.com, openrouter.ai', desc: 'Reads your plan’s usage limits about every 30 seconds while a subscription or key is connected.' },
  { id: 'connectors', label: 'Connectors', group: 'background', where: 'GitHub, Slack, Linear and the others you connect', desc: 'Fetches context for each turn and polls for workflow triggers. Sends text from the turn.' },
  { id: 'decide', label: 'Decision models', group: 'background', where: 'api.typesafe.ai, github.com', desc: 'Hosted decisions on each turn when a TypeSafe key is set (sends turn text), and decision model downloads.' },
  { id: 'telemetry', label: 'Usage and crash reports', group: 'background', where: 'us.i.posthog.com', desc: 'Only if you turned on Help improve Nekko Agent: anonymous feature use and scrubbed errors, sent once a minute.' },
  { id: 'github', label: 'GitHub pull requests', group: 'background', where: 'api.github.com, your git remotes', desc: 'PR status every 20 seconds while a PR card is open, and git fetches for PR checkouts.' },
  { id: 'telegram', label: 'Telegram', group: 'background', where: 'api.telegram.org', desc: 'Waits for messages to your bot while the Telegram channel is on.' },
  { id: 'model-providers', label: 'Cloud model providers', group: 'onDemand', where: 'The providers you set up', desc: 'Every chat turn sent to a cloud model. Local models on this computer are not affected.' },
  { id: 'sign-in', label: 'Provider sign-in', group: 'onDemand', where: 'auth.openai.com, openrouter.ai, oauth2.googleapis.com', desc: 'Signing in to a provider and refreshing its token.' },
  { id: 'models', label: 'Models and runtimes', group: 'onDemand', where: 'huggingface.co, github.com', desc: 'Browsing and downloading models, and installing llama.cpp, MLX and voice.' },
  { id: 'skill-sources', label: 'Skill sources', group: 'onDemand', where: 'api.github.com', desc: 'Browsing and installing skills from GitHub.' },
  { id: 'web-tools', label: 'Web tools', group: 'onDemand', where: 'Any public website', desc: 'An agent’s fetch and browser tools, and photos shown in replies.' },
  { id: 'mcp', label: 'MCP servers', group: 'onDemand', where: 'The MCP servers you add', desc: 'Remote (HTTP) MCP servers, when a chat uses their tools.' },
  { id: 'browser-pane', label: 'In-app browser', group: 'onDemand', where: 'Any website', desc: 'Pages you open in the browser pane.' },
  { id: 'feedback', label: 'Send feedback', group: 'onDemand', where: 'nekko-agent-api.fly.dev', desc: 'Only when you press Send in the feedback sheet.' },
  { id: 'resource-queue', label: 'Resource queue', group: 'onDemand', where: 'The coordinator you set', desc: 'Experimental: claiming jobs, with a heartbeat every minute while one runs.' },
  { id: 'api-server', label: 'API server', group: 'listener', where: 'This computer, or your network if set to LAN', desc: 'Lets the CLI and MCP clients drive Nekko Agent.' },
  { id: 'model-server-lan', label: 'Model server on your network', group: 'listener', where: 'Your local network', desc: 'Serves your local models to other devices when Model Server is bound to LAN. Off here keeps it on this computer only.' },
  { id: 'local-relay', label: 'Relay on this computer', group: 'listener', where: 'Your tailnet and local network', desc: 'Lets your phone connect without Nekko Cloud.' },
  { id: 'network-visibility', label: 'Visible on this network', group: 'listener', where: 'Your local network (mDNS)', desc: 'Announces this computer so your phone can find it.' },
  { id: 'webhook-listener', label: 'Workflow webhooks', group: 'listener', where: 'This computer (127.0.0.1:1441)', desc: 'Experimental: receives webhooks that start workflows.' },
];

/** One row of `connections:status`. */
export interface ConnectionStatus {
  id: string;
  /** Last event, ms since the epoch. */
  lastAt: number | null;
  count24h: number;
  errors24h: number;
  blocked24h: number;
  allowed: boolean;
}

export interface ConnectionsStatus {
  allOff: boolean;
  connections: ConnectionStatus[];
}

/** One logged event (`connections:events`). Never a body, header, token or query string. */
export interface ConnectionEvent {
  at: number;
  id: string;
  kind: 'request' | 'connect' | 'listen' | 'close' | 'blocked';
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  bytes?: number;
  ms?: number;
  error?: string;
}

/** Whether `id` may connect under these settings (the same rule the engine applies). */
export function connectionAllowed(s: ConnectionSettings | undefined, id: string): boolean {
  return !s?.allOff && !(s?.blocked ?? []).includes(id);
}

/** The settings with `id` switched on or off. */
export function withConnection(s: ConnectionSettings | undefined, id: string, on: boolean): ConnectionSettings {
  const blocked = (s?.blocked ?? []).filter((b) => b !== id);
  return { ...s, blocked: on ? blocked : [...blocked, id] };
}
