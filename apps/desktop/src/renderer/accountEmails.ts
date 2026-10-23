import { useEffect, useState } from 'react';
import type { ProviderConfig } from '@nekko-agent/shared';
import { isLocalProvider } from '@nekko-agent/shared';

/**
 * The email each signed-in provider uses, so two accounts on one vendor (a
 * personal and a work Claude plan, say) read differently wherever providers
 * are listed. Comes from the host's sanitized sign-in status, never a token;
 * a provider signed in before emails were recorded, or one on an API key,
 * has none until it signs in again.
 */
export function useAccountEmails(providers: ProviderConfig[]): Record<string, string> {
  const [byToken, setByToken] = useState<Record<string, string>>({});
  const signedIn = providers.filter((p) => p.tokenKey);
  const keysId = signedIn.map((p) => `${p.id}=${p.tokenKey}`).sort().join('|');

  useEffect(() => {
    if (!signedIn.length || !window.nekko?.oauthStatus) return;
    let live = true;
    void Promise.all(
      signedIn.map((p) => window.nekko.oauthStatus(p.id).then((s) => [p.tokenKey!, s.accountEmail] as const).catch(() => [p.tokenKey!, undefined] as const)),
    ).then((entries) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const [key, email] of entries) if (email) next[key] = email;
      setByToken(next);
    });
    const keys = new Set(signedIn.map((p) => p.tokenKey));
    const off = window.nekko.onOAuthStatus?.((s) => {
      if (!s.tokenKey || !keys.has(s.tokenKey) || !s.accountEmail) return;
      const email = s.accountEmail;
      setByToken((prev) => (prev[s.tokenKey] === email ? prev : { ...prev, [s.tokenKey]: email }));
    });
    return () => { live = false; off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysId]);

  return byToken;
}

/** The email a provider is signed in as, if known. */
export function accountEmailOf(provider: ProviderConfig, emails: Record<string, string>): string | undefined {
  return provider.tokenKey ? emails[provider.tokenKey] : undefined;
}

/** "Anthropic (Claude) · davide@example.com", or just the label without an email. */
export function providerDisplayName(provider: ProviderConfig, emails: Record<string, string>): string {
  const email = accountEmailOf(provider, emails);
  return email ? `${provider.label} · ${email}` : provider.label;
}

/**
 * The accounts a chat can switch between: every enabled provider of the same
 * kind as `current` (two ChatGPT plans, two Anthropic keys, two Claude Agent
 * logins), `current` included, in the order they are listed. Local model
 * servers are machines, not accounts, so they never get a switcher. Fewer
 * than two means there is nothing to switch to.
 */
export function accountSiblings(providers: ProviderConfig[], current: ProviderConfig | undefined): ProviderConfig[] {
  if (!current || isLocalProvider(current.kind)) return [];
  const same = providers.filter((p) => p.kind === current.kind && (p.enabled !== false || p.id === current.id));
  return same.length > 1 ? same : [];
}

/** An account's short name for the switcher: its email, else its label. */
export function accountShortName(provider: ProviderConfig, emails: Record<string, string>): string {
  return accountEmailOf(provider, emails) ?? provider.label;
}
