/**
 * The Claude policy table: which Nekko features each Claude auth gets.
 *
 * Anthropic's terms let a third-party app use Claude on the user's own API key
 * or cloud account without limits, but a Claude plan only through the user's
 * own, unmodified Claude Code, and some features on a plan stay off until
 * Anthropic approves them. This table is the one source for those gates: nekkod
 * enforces it (its Rust mirror, `crates/nekko-agent/src/claude_policy.rs`,
 * is pinned to this file by a golden test), the UI renders its states and
 * reasons, and the comparison table in the docs is generated from it.
 *
 * Unlocking a feature after Anthropic says yes is a one-row change here (or a
 * signed `claudePolicy` document nekkod verifies). There is never an end-user
 * switch: a user-flippable toggle would make Nekko the party offering it.
 */

import type { ClaudeCodeContext } from './chat.js';
import type { SubscriptionLimits } from './limits.js';

/** How the Claude behind a provider is paid for. */
export type ClaudeAuth = 'api_key' | 'cloud' | 'subscription' | 'unknown';

export const CLAUDE_AUTHS: readonly ClaudeAuth[] = ['api_key', 'cloud', 'subscription', 'unknown'];

/** A Nekko feature whose availability depends on how Claude is paid for. */
export type ClaudeCapability =
  | 'interactive_chat'
  | 'phone_remote'
  | 'unattended_runs'
  | 'nekko_tools'
  | 'context_note'
  | 'usage_limits'
  | 'cost_estimate'
  | 'model_routing';

export const CLAUDE_CAPABILITIES: readonly ClaudeCapability[] = [
  'interactive_chat',
  'phone_remote',
  'unattended_runs',
  'nekko_tools',
  'context_note',
  'usage_limits',
  'cost_estimate',
  'model_routing',
];

/**
 * - `enabled`: works.
 * - `awaiting_approval`: fully built and tested, off until Anthropic says yes.
 * - `unsupported`: structurally impossible on this path; no approval turns it on.
 */
export type ClaudeRowState = 'enabled' | 'awaiting_approval' | 'unsupported';

/** Why a row is not `enabled`; each has one user-facing line in `CLAUDE_REASONS`. */
export type ClaudeReasonId =
  | 'awaiting_anthropic'
  | 'unattended_needs_api_key'
  | 'nekko_tools_need_api_key'
  | 'context_note_needs_api_key'
  | 'usage_in_claude_code'
  | 'billed_to_plan'
  | 'claude_code_owns_loop';

export interface ClaudePolicyRow {
  state: ClaudeRowState;
  reason?: ClaudeReasonId;
}

export type ClaudePolicy = Record<ClaudeAuth, Record<ClaudeCapability, ClaudePolicyRow>>;

/** What kind of limit a reason explains: pending approval, a structural limit, or billing. */
export type ClaudeReasonKind = 'awaiting_anthropic' | 'structural' | 'billing';

export interface ClaudeReason {
  kind: ClaudeReasonKind;
  /** One line under a greyed control, followed by a "Why?" link to the plan sheet. */
  text: string;
  /** The comparison table's cell for this row. */
  cell: string;
}

/**
 * The user-facing reason lines. Tone: factual and calm, never blaming
 * Anthropic, never implying a partnership or that approval is coming.
 */
export const CLAUDE_REASONS: Record<ClaudeReasonId, ClaudeReason> = {
  awaiting_anthropic: {
    kind: 'awaiting_anthropic',
    text: "Off with a Claude plan for now: the terms don't clearly cover it for third-party apps.",
    cell: 'Not yet',
  },
  unattended_needs_api_key: {
    kind: 'awaiting_anthropic',
    text: 'Scheduled runs need Claude with an API key.',
    cell: 'Not yet',
  },
  nekko_tools_need_api_key: {
    kind: 'awaiting_anthropic',
    text: 'Nekko tools inside a Claude chat need Claude with an API key.',
    cell: 'Not yet',
  },
  context_note_needs_api_key: {
    kind: 'awaiting_anthropic',
    text: "Nekko's workspace note for Claude Code needs Claude with an API key.",
    cell: 'Not yet',
  },
  usage_in_claude_code: {
    kind: 'awaiting_anthropic',
    text: "Check your plan's usage in Claude Code.",
    cell: 'No, check in Claude Code',
  },
  billed_to_plan: {
    kind: 'billing',
    text: 'Billed to your Claude plan, so Nekko shows tokens, not a cost.',
    cell: 'No, billed to your plan',
  },
  claude_code_owns_loop: {
    kind: 'structural',
    text: "Claude Code runs this chat's model choices.",
    cell: 'No',
  },
};

/** The reason a row carries when it is `awaiting_approval` (also for a signed override). */
export const CLAUDE_AWAITING_REASON: Record<ClaudeCapability, ClaudeReasonId> = {
  interactive_chat: 'awaiting_anthropic',
  phone_remote: 'awaiting_anthropic',
  unattended_runs: 'unattended_needs_api_key',
  nekko_tools: 'nekko_tools_need_api_key',
  context_note: 'context_note_needs_api_key',
  usage_limits: 'usage_in_claude_code',
  cost_estimate: 'awaiting_anthropic',
  model_routing: 'awaiting_anthropic',
};

const ON: ClaudePolicyRow = { state: 'enabled' };
const awaiting = (cap: ClaudeCapability): ClaudePolicyRow => ({
  state: 'awaiting_approval',
  reason: CLAUDE_AWAITING_REASON[cap],
});
const ALL_ON: Record<ClaudeCapability, ClaudePolicyRow> = {
  interactive_chat: ON,
  phone_remote: ON,
  unattended_runs: ON,
  nekko_tools: ON,
  context_note: ON,
  usage_limits: ON,
  cost_estimate: ON,
  model_routing: ON,
};
const PLAN: Record<ClaudeCapability, ClaudePolicyRow> = {
  interactive_chat: ON,
  phone_remote: ON,
  unattended_runs: awaiting('unattended_runs'),
  nekko_tools: awaiting('nekko_tools'),
  context_note: awaiting('context_note'),
  usage_limits: awaiting('usage_limits'),
  // Plan usage has no per-turn price; the UI shows tokens, "billed to your Claude plan".
  cost_estimate: { state: 'unsupported', reason: 'billed_to_plan' },
  // A plan only ever runs through Claude Code, which owns the loop.
  model_routing: { state: 'unsupported', reason: 'claude_code_owns_loop' },
};

/**
 * The shipped table. `api_key` and `cloud` keep every feature; `subscription`
 * has the four approval-gated features off; `unknown` (Claude Code's auth
 * status could not be read) is the same as `subscription`: fail closed.
 */
export const CLAUDE_POLICY: ClaudePolicy = {
  api_key: ALL_ON,
  cloud: ALL_ON,
  subscription: PLAN,
  unknown: PLAN,
};

/** Which Claude engine runs a turn: Nekko's own loop, or the user's Claude Code. */
export type ClaudeEngine = 'nekko' | 'claude-code';

/**
 * What a Claude Code harness turn cannot do on any auth, because Claude Code
 * runs its own loop: Nekko's model router (and mid-chat swaps) never reach it.
 */
export const CLAUDE_CODE_UNSUPPORTED: Partial<Record<ClaudeCapability, ClaudeReasonId>> = {
  model_routing: 'claude_code_owns_loop',
};

/** The provider kind of the Claude Code harness ("Claude Agent"). */
export const CLAUDE_CODE_PROVIDER_KIND = 'claude-code';

/**
 * What Claude Code last reported about a Claude Agent chat's context, for the
 * chat's current model: `undefined` before its first turn or once the model
 * changed, when the gauges fall back to Nekko's estimate and the alias guess.
 */
export function reportedClaudeCodeContext(
  session: { claudeCodeContext?: ClaudeCodeContext; modelId?: string } | null | undefined,
  modelId: string | undefined = session?.modelId,
): { used: number; window?: number } | undefined {
  const c = session?.claudeCodeContext;
  if (!c || c.used === undefined || c.modelId !== modelId) return undefined;
  return { used: c.used, ...(c.window ? { window: c.window } : {}) };
}

/** Provider kinds that run Claude on the user's own cloud account. */
export const CLAUDE_CLOUD_PROVIDER_KINDS: readonly string[] = ['bedrock', 'vertex', 'foundry'];

/** The part of `claude auth status --json` the policy reads. */
export interface ClaudeCodeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

/** The provider fields `claudeAuthFor` reads (a `ProviderConfig`, or a harness provider). */
export interface ClaudeProviderLike {
  kind: string;
  auth?: string;
  claudeCode?: { authSource?: string; account?: string };
}

/**
 * A second Claude Code account's name, as nekkod accepts it
 * (`nekko_harness::is_account_name`): 1 to 32 of a-z, 0-9 and "-", not
 * starting or ending with "-". It picks the folder `~/.claude-<name>`.
 */
export function isClaudeAccountName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name);
}

/** "Work (Acme)" → "work-acme": a typed account label as an account name, or "" when nothing usable is left. */
export function claudeAccountName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
}

const API_KEY_METHODS = ['api_key', 'apikey', 'api_key_helper', 'apikeyhelper'];
const PLAN_METHODS = ['claude.ai', 'claude_ai', 'claudeai', 'oauth', 'oauth_token', 'subscription'];

/** Map `claude auth status` to an auth. Signed out, unreadable or unrecognized is `unknown`. */
export function claudeAuthFromStatus(status?: ClaudeCodeAuthStatus | null): ClaudeAuth {
  if (!status || status.loggedIn === false) return 'unknown';
  const provider = (status.apiProvider ?? '').toLowerCase();
  if (CLAUDE_CLOUD_PROVIDER_KINDS.includes(provider)) return 'cloud';
  const method = (status.authMethod ?? '').toLowerCase();
  if (CLAUDE_CLOUD_PROVIDER_KINDS.includes(method)) return 'cloud';
  if (API_KEY_METHODS.includes(method)) return 'api_key';
  if (PLAN_METHODS.includes(method)) return 'subscription';
  return 'unknown';
}

/**
 * How the Claude behind `provider` is paid for, or `null` when it is not a
 * Claude provider. For the Claude Code harness, an auth source Nekko set
 * itself (the user's own Anthropic key, or a cloud) is known without asking;
 * otherwise it is what `claude auth status` reported, `unknown` without one.
 */
export function claudeAuthFor(provider: ClaudeProviderLike, authStatus?: ClaudeCodeAuthStatus | null): ClaudeAuth | null {
  const kind = provider.kind;
  if (kind === 'anthropic') return provider.auth === 'subscription' ? 'subscription' : 'api_key';
  if (CLAUDE_CLOUD_PROVIDER_KINDS.includes(kind)) return 'cloud';
  if (kind !== CLAUDE_CODE_PROVIDER_KIND) return null;
  const source = provider.claudeCode?.authSource;
  if (source === 'nekko-anthropic-key') return 'api_key';
  if (source && CLAUDE_CLOUD_PROVIDER_KINDS.includes(source)) return 'cloud';
  return claudeAuthFromStatus(authStatus);
}

/** Which engine a provider kind runs Claude on. */
export function claudeEngineFor(kind: string): ClaudeEngine {
  return kind === CLAUDE_CODE_PROVIDER_KIND ? 'claude-code' : 'nekko';
}

/**
 * One capability's row for an auth on an engine, read from `policy` (the
 * effective table nekkod reports, else the shipped one). A Claude Code turn
 * adds its structural limits on top.
 */
export function claudeCapability(
  auth: ClaudeAuth,
  cap: ClaudeCapability,
  engine: ClaudeEngine = 'claude-code',
  policy: ClaudePolicy = CLAUDE_POLICY,
): ClaudePolicyRow {
  const structural = engine === 'claude-code' ? CLAUDE_CODE_UNSUPPORTED[cap] : undefined;
  if (structural) return { state: 'unsupported', reason: structural };
  return policy[auth][cap];
}

/** Whether a capability is on. */
export function claudeAllows(
  auth: ClaudeAuth,
  cap: ClaudeCapability,
  engine: ClaudeEngine = 'claude-code',
  policy: ClaudePolicy = CLAUDE_POLICY,
): boolean {
  return claudeCapability(auth, cap, engine, policy).state === 'enabled';
}

/** The user-facing line for a row that is not enabled, or `null` when it is. */
export function claudeReasonText(row: ClaudePolicyRow): string | null {
  if (row.state === 'enabled') return null;
  return CLAUDE_REASONS[row.reason ?? 'awaiting_anthropic'].text;
}

/**
 * Why an unattended turn (`SendOptions.unattended`) may not run on
 * `provider`, or `null` when it may. Only Claude Code harness turns are
 * gated (nekkod's `gate_turn` is the same rule); with no auth status here,
 * an auth Nekko did not set itself is `unknown` and fails closed.
 */
export function claudeUnattendedRefusal(
  provider: ClaudeProviderLike,
  authStatus?: ClaudeCodeAuthStatus | null,
  policy: ClaudePolicy = CLAUDE_POLICY,
): string | null {
  if (provider.kind !== CLAUDE_CODE_PROVIDER_KIND) return null;
  const auth = claudeAuthFor(provider, authStatus) ?? 'unknown';
  return claudeReasonText(claudeCapability(auth, 'unattended_runs', 'claude-code', policy));
}

/** One column of the comparison table under the two Claude provider cards. */
export interface ClaudeComparisonColumn {
  id: 'claude_api' | 'agent_api_key' | 'agent_plan';
  label: string;
  auth: ClaudeAuth;
  engine: ClaudeEngine;
  billedTo: string;
}

export const CLAUDE_COMPARISON_COLUMNS: readonly ClaudeComparisonColumn[] = [
  { id: 'claude_api', label: 'Claude (API or cloud)', auth: 'api_key', engine: 'nekko', billedTo: 'Your API or cloud account' },
  { id: 'agent_api_key', label: 'Claude Agent with an API key', auth: 'api_key', engine: 'claude-code', billedTo: 'Your API account' },
  { id: 'agent_plan', label: 'Claude Agent with a Claude plan', auth: 'subscription', engine: 'claude-code', billedTo: 'Your Claude plan' },
];

/** The comparison table's rows, in order, with their labels. */
export const CLAUDE_COMPARISON_ROWS: readonly { capability: ClaudeCapability; label: string }[] = [
  { capability: 'interactive_chat', label: 'Chat, files, code edits, approvals' },
  { capability: 'phone_remote', label: 'Phone remote' },
  { capability: 'unattended_runs', label: 'Scheduled tasks and watches' },
  { capability: 'nekko_tools', label: 'Nekko tools inside the chat' },
  { capability: 'usage_limits', label: 'Usage limits in Nekko' },
  { capability: 'model_routing', label: 'Model routing and mixing providers' },
];

/** The comparison table as cells, generated from the policy (never hand-written). */
export function claudeComparisonTable(policy: ClaudePolicy = CLAUDE_POLICY): {
  columns: readonly ClaudeComparisonColumn[];
  rows: { capability: ClaudeCapability; label: string; cells: string[] }[];
  billedTo: string[];
} {
  return {
    columns: CLAUDE_COMPARISON_COLUMNS,
    rows: CLAUDE_COMPARISON_ROWS.map(({ capability, label }) => ({
      capability,
      label,
      cells: CLAUDE_COMPARISON_COLUMNS.map((c) => {
        const row = claudeCapability(c.auth, capability, c.engine, policy);
        return row.state === 'enabled' ? 'Yes' : CLAUDE_REASONS[row.reason ?? 'awaiting_anthropic'].cell;
      }),
    })),
    billedTo: CLAUDE_COMPARISON_COLUMNS.map((c) => c.billedTo),
  };
}

/** The "What works with a Claude plan?" sheet, linked from every "Why?". */
export const CLAUDE_PLAN_SHEET = {
  title: 'Using your Claude plan in Nekko Agent',
  paragraphs: [
    "Anthropic's terms say apps like Nekko Agent can't sign you in to your Claude account or send requests on your plan for you. So we don't. Instead, Claude Agent runs the Claude Code you already have installed, and you sign in inside Claude Code itself. Nekko never sees your Claude login.",
    "With a Claude plan, you can chat, edit code, approve actions and use your phone, all on your plan. A few things are off for now because the terms don't clearly cover them for third-party apps: scheduled tasks, Nekko's own tools inside a Claude chat, and showing your plan's usage limits.",
    'Want everything? Use Claude with an API key or through AWS Bedrock, Google Vertex AI or Microsoft Foundry. You get every Nekko feature, billed to your own account.',
  ],
} as const;

/**
 * What nekkod reports on `claude:policy`: the effective table (the shipped
 * one, plus a verified signed override, plus the dev-only preview), and where
 * it came from, so the renderer shows exactly what the daemon enforces.
 */
export interface ClaudePolicyStatus {
  policy: ClaudePolicy;
  /** A signed override nekkod verified and applied: its serial and when it was issued. */
  override: { serial: number; issuedAt: string } | null;
  /** The dev-only preview (`NEKKO_CLAUDE_POLICY_PREVIEW`); always `null` in a release build. */
  preview: ClaudeAuth | null;
}

/** `claude:capability(providerId, capability)`: the row one provider gets, for a greyed control. */
export type ClaudeCapabilityStatus =
  | { claude: false }
  | { claude: true; auth: ClaudeAuth; state: ClaudeRowState; reason: ClaudeReasonId | null; message: string | null };

/**
 * `claude:codeStatus(providerId?)`: whether the user's own Claude Code is
 * installed and how it is signed in (from `claude --version` and `claude auth
 * status`; Nekko never reads its credentials). `auth` is the policy row it maps
 * to; `unknown` while signed out.
 */
export type ClaudeCodeStatus =
  | { installed: false; message: string }
  | { installed: true; version: string; loggedIn: false; authMethod?: string; apiProvider?: string | null; auth?: ClaudeAuth; message?: string }
  | { installed: true; version: string; loggedIn: true; authMethod: string; apiProvider?: string | null; auth: ClaudeAuth };

/**
 * `claude:planUsage(providerId)`: `claude-code` is the plan usage the user's
 * own Claude Code last printed in its documented stream output
 * (`rate_limit_event`, `/usage`'s `usage_report`), answered only where the
 * `usage_limits` row allows it; otherwise `none` with the reason. The dev-only
 * preview answers `example` and the UI renders `claudePlanUsageExample()`
 * with its label.
 */
export type ClaudePlanUsageStatus =
  | { source: 'none'; message: string }
  | { source: 'example'; label: string }
  | { source: 'claude-code'; limits: SubscriptionLimits };
