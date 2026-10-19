import type { OAuthProvider } from './oauth.js';

/**
 * An OAuth client a vendor issued to Nekko Agent itself. Every field is null
 * until the vendor hands us one: a null `clientId` means the sign-in is not
 * offered anywhere.
 */
export interface ApprovedOAuthClient {
  /** 'awaiting_approval' until the vendor approves in-app sign-in for Nekko Agent. */
  state: 'awaiting_approval' | 'enabled';
  clientId: string | null;
  authorizeUrl: string | null;
  tokenUrl: string | null;
  /** Space-separated scopes, as the vendor specifies them. */
  scopes: string | null;
  /** Extra headers the vendor asks for on model requests. Nothing borrowed from another client. */
  requestHeaders: Record<string, string>;
}

/**
 * The approved-client slot for Claude sign-in (mirrored in crates/nekko-oauth).
 *
 * Anthropic does not let third-party apps offer Claude.ai login or send
 * requests on a Claude plan's credentials, so this slot is empty and the
 * Claude sign-in is hidden. If Anthropic ever issues Nekko Agent its own
 * client, filling these fields (and the matching policy row) in one reviewed
 * PR turns it on. Never put another app's client id here:
 * scripts/check-claude-compliance.mjs fails CI if this slot is filled.
 */
export const CLAUDE_APPROVED_CLIENT: ApprovedOAuthClient = {
  state: 'awaiting_approval',
  clientId: null,
  authorizeUrl: null,
  tokenUrl: null,
  scopes: null,
  requestHeaders: {},
};

/** Whether the app offers sign-in through `provider` at all. */
export function oauthProviderOffered(provider: OAuthProvider): boolean {
  if (provider !== 'claude') return true;
  const c = CLAUDE_APPROVED_CLIENT;
  return c.state === 'enabled' && !!c.clientId && !!c.authorizeUrl && !!c.tokenUrl;
}

/** The refusal a sign-in through an unoffered provider fails with. */
export const CLAUDE_SIGN_IN_UNAVAILABLE =
  'Nekko Agent cannot sign in to Claude plans. Use Claude with an API key or a cloud account, or connect Claude Agent to run your installed Claude Code.';
