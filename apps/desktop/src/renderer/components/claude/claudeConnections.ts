import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { claudePlanLabel } from '@nekko-agent/shared';

const sources: Partial<Record<ProviderConfig['kind'], string>> = {
  'claude-code': 'Subscription', anthropic: 'Anthropic API', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry',
};

export function isClaudeConnection(provider: ProviderConfig): boolean {
  return !!sources[provider.kind] && !(provider.kind === 'anthropic' && provider.auth === 'subscription');
}

export function claudeConnectionLabel(provider: ProviderConfig): string {
  return `${provider.label} · ${sources[provider.kind] ?? 'API'}`;
}

export function claudeConnectionDetail(provider: ProviderConfig, status?: ClaudeCodeStatus | null): string {
  if (provider.kind !== 'claude-code') {
    return `Billed separately to ${sources[provider.kind] ?? 'the API account'}${provider.workspaceId ? ` · Workspace: ${provider.workspaceId}` : ''}.`;
  }
  const profile = provider.claudeCode?.account ?? 'usual login';
  if (!status) return `Checking Claude Code identity · ${profile}`;
  if (!status.installed) return `Claude Code unavailable · ${profile}`;
  if (!status.loggedIn) return `Sign-in required in Claude Code · ${profile}`;
  if (status.auth !== 'subscription') return `Claude Code reports ${status.authMethod}, not a subscription · ${profile}`;
  const identity = [status.email, status.orgName, claudePlanLabel(status.subscriptionType)].filter(Boolean).join(' · ');
  return `${identity || 'Signed in; account identity not reported'} · Profile: ${profile}`;
}

/** Never reopen sign-in in a folder a saved provider already uses. */
export function claudeProfileConflict(providers: ProviderConfig[], name: string): ProviderConfig | undefined {
  return name ? providers.find(p => p.kind === 'claude-code' && p.claudeCode?.account?.toLowerCase() === name.toLowerCase()) : undefined;
}

/** A connection is only a filter. A model click commits the exact provider/model pair. */
export function filterClaudeConnections(providers: ProviderConfig[], selected: string): ProviderConfig[] {
  return providers.filter(p => p.enabled !== false && (selected === 'all' || (isClaudeConnection(p) && p.id === selected)));
}
