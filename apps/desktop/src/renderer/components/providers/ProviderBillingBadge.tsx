import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { isLocalProvider, oauthProviderOffered } from '@nekko-agent/shared';
import { Badge } from '../primitives/index.js';

/** Billing mode is separate from connection health and how a key was obtained. */
export function ProviderBillingBadge({ provider, claudeStatus }: { provider: ProviderConfig; claudeStatus?: ClaudeCodeStatus | null }) {
  if (provider.enabled === false || isLocalProvider(provider.kind)) return null;
  let subscription = false;
  if (provider.kind === 'claude-code') {
    // Never call an unknown, signed-out or API-backed Claude Code login a plan.
    if (!claudeStatus?.installed || !claudeStatus.loggedIn) return null;
    if (claudeStatus.auth === 'subscription') subscription = true;
    else if (claudeStatus.auth !== 'api_key' && claudeStatus.auth !== 'cloud') return null;
  } else {
    if (provider.kind === 'anthropic' && provider.auth === 'subscription' && !oauthProviderOffered('claude')) return null;
    subscription = provider.kind !== 'openrouter' && (provider.kind === 'chatgpt' || provider.auth === 'subscription');
  }
  return <span className="inline-flex" data-provider-billing={subscription ? 'subscription' : 'api'}><Badge
    tone={subscription ? 'success' : 'neutral'}
    variant="soft"
    title={subscription
      ? `Runs on your ${provider.kind === 'chatgpt' ? 'ChatGPT' : 'Claude'} subscription instead of a metered API key`
      : 'Uses an API account, not a subscription plan. Usage follows the API provider’s pricing.'}
  >{subscription ? 'Subscription' : 'API'}</Badge></span>;
}
