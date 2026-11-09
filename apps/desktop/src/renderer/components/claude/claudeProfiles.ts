import type { ProviderConfig } from '@nekko-agent/shared';

/** Never reopen sign-in in a folder a saved provider already uses (disabled ones included). */
export function claudeProfileConflict(providers: ProviderConfig[], name: string): ProviderConfig | undefined {
  return name ? providers.find(p => p.kind === 'claude-code' && p.claudeCode?.account?.toLowerCase() === name.toLowerCase()) : undefined;
}
