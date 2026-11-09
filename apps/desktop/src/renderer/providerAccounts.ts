import { useEffect, useMemo, useState } from 'react';
import type { ClaudeCodeStatus, ProviderConfig } from '@nekko-agent/shared';
import { isLocalProvider } from '@nekko-agent/shared';
import { providerMarkKind } from './components/providers/ProviderMark.js';
import { useAccountEmails } from './accountEmails.js';

/**
 * Accounts, as the user thinks of them. Every saved provider is one account
 * (a Claude plan login, an organization seat on the same email, an API key);
 * providers that sell the same models group into one family, so "Claude" lists
 * Personal (Max), Acme (Team) and a Production API key side by side instead of
 * three unrelated providers.
 */

export interface AccountFamily {
  id: string;
  /** "Claude", "OpenAI", or a custom endpoint's own label. */
  name: string;
  providers: ProviderConfig[];
}

const CLAUDE_KINDS = new Set<ProviderConfig['kind']>(['claude-code', 'anthropic', 'bedrock', 'vertex', 'foundry']);
const OPENAI_KINDS = new Set<ProviderConfig['kind']>(['chatgpt', 'openai']);

/** Which family a cloud provider belongs to. Local servers are machines, each its own. */
export function familyOf(provider: ProviderConfig): { id: string; name: string } {
  if (!isLocalProvider(provider.kind)) {
    if (CLAUDE_KINDS.has(provider.kind)) return { id: 'claude', name: 'Claude' };
    if (OPENAI_KINDS.has(provider.kind)) return { id: 'openai', name: 'OpenAI' };
    if (provider.kind === 'openrouter') return { id: 'openrouter', name: 'OpenRouter' };
    const mark = providerMarkKind(provider);
    if (mark === 'gemini') return { id: 'gemini', name: 'Gemini' };
    if (mark === 'ollama-cloud') return { id: 'ollama-cloud', name: 'Ollama Cloud' };
  }
  return { id: `provider:${provider.id}`, name: provider.label ?? provider.id };
}

/** Providers grouped by family, in the order each family first appears. */
export function accountFamilies(providers: ProviderConfig[]): AccountFamily[] {
  const out: AccountFamily[] = [];
  for (const p of providers) {
    const f = familyOf(p);
    const existing = out.find((x) => x.id === f.id);
    if (existing) existing.providers.push(p);
    else out.push({ ...f, providers: [p] });
  }
  return out;
}

export interface AccountIdentity {
  /** What the account is called: "Personal", the organization, or the key's name. */
  name: string;
  /** A second, fainter word: the plan ("Max", "Team") or the billing route ("API"). */
  hint?: string;
  email?: string;
  /** Saved, but the login behind it is signed out. */
  signedOut?: boolean;
  /** A seat in an organization rather than a plan bought for oneself. */
  organization?: boolean;
}

const KIND_HINT: Partial<Record<ProviderConfig['kind'], string>> = {
  anthropic: 'API', bedrock: 'Bedrock', vertex: 'Vertex AI', foundry: 'Foundry', chatgpt: 'Subscription', openai: 'API',
};
const KIND_NAME: Partial<Record<ProviderConfig['kind'], string>> = {
  anthropic: 'Anthropic', bedrock: 'AWS', vertex: 'Google Cloud', foundry: 'Azure', chatgpt: 'ChatGPT', openai: 'OpenAI', 'claude-code': 'Subscription',
};
const ORG_PLANS = new Set(['team', 'enterprise']);
const capital = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

/** A saved label without the family and billing words the group already says. */
function ownName(label: string, family: string): string {
  const brand = family === 'Claude' ? '(claude|anthropic)' : family === 'OpenAI' ? '(openai|chatgpt)' : null;
  let s = label.replace(/\((subscription|api|plan)\)/gi, '');
  if (brand) s = s.replace(new RegExp(`^\\s*${brand}\\b`, 'i'), '');
  s = s.replace(/^\s*(subscription|agent)\b/i, '');
  return s.replace(/^[\s·:–-]+|[\s·:–-]+$/g, '').trim();
}

/**
 * How one account reads. Claude subscription logins name themselves from what
 * Claude Code reports (a personal plan reads "Personal · Max", an organization
 * seat reads as the organization, "Acme · Team"), so one email with both shows
 * two clearly different accounts. Other accounts use their saved name.
 */
export function accountIdentity(
  provider: ProviderConfig,
  known: { claude?: ClaudeCodeStatus | null; email?: string } = {},
): AccountIdentity {
  const family = familyOf(provider).name;
  // An older or partial config can lack a label.
  const label = provider.label ?? '';
  if (provider.kind === 'claude-code') {
    // "Claude subscription · Work": the part after the dot is the name the user typed.
    const typed = label.includes(' · ') ? label.split(' · ').slice(1).join(' · ').trim() : ownName(label, family);
    const named = typed || undefined;
    const s = known.claude;
    if (s?.installed && s.loggedIn) {
      if (s.auth !== 'subscription') return { name: named ?? 'Claude Code', hint: 'API', email: s.email ?? undefined };
      const plan = s.subscriptionType?.trim().toLowerCase() ?? '';
      const organization = ORG_PLANS.has(plan);
      return {
        name: organization ? (s.orgName?.trim() || named || 'Organization') : (named ?? 'Personal'),
        hint: plan ? capital(plan) : undefined,
        email: s.email ?? undefined,
        organization,
      };
    }
    if (s?.installed && !s.loggedIn) return { name: named ?? 'Subscription', hint: 'Signed out', signedOut: true };
    return { name: named ?? 'Subscription' };
  }
  const hint = KIND_HINT[provider.kind];
  const own = ownName(label, family);
  const name = !own || (hint && own.toLowerCase() === hint.toLowerCase()) ? (KIND_NAME[provider.kind] ?? (label || provider.id)) : own;
  return { name, hint: name === hint ? undefined : hint, email: known.email };
}

/** Two accounts that would read the same are told apart by their email. */
export function disambiguate(identities: Record<string, AccountIdentity>, ids: string[]): Record<string, AccountIdentity> {
  const out = { ...identities };
  const key = (i: AccountIdentity) => `${i.name}\u0000${i.hint ?? ''}`;
  for (const id of ids) {
    const mine = out[id];
    if (!mine?.email) continue;
    // Compare against the originals, so the second of a matching pair is renamed too.
    if (ids.some((other) => other !== id && identities[other] && key(identities[other]) === key(mine))) out[id] = { ...mine, name: mine.email };
  }
  return out;
}

/**
 * The one login email behind a family's accounts: every account that reports
 * an email reports the same one. An API key has none and does not disagree.
 * Undefined when two emails differ or none is known.
 */
export function sharedEmail(identities: AccountIdentity[]): string | undefined {
  const withEmail = identities.filter((i) => i.email);
  const emails = new Set(withEmail.map((i) => i.email!.toLowerCase()));
  return emails.size === 1 ? withEmail[0].email : undefined;
}

// `claude auth status` spawns a process; the picker opens often, so answers are
// shared and kept for a minute.
const CLAUDE_TTL_MS = 60_000;
const claudeCache = new Map<string, { at: number; value: Promise<ClaudeCodeStatus | null> }>();
function claudeStatusOf(provider: ProviderConfig): Promise<ClaudeCodeStatus | null> {
  const key = `${provider.id}|${provider.claudeCode?.account ?? ''}`;
  const hit = claudeCache.get(key);
  if (hit && Date.now() - hit.at < CLAUDE_TTL_MS) return hit.value;
  const get = window.nekko?.getClaudeCodeStatus;
  const value = get ? get(provider.id).catch(() => null) : Promise.resolve(null);
  claudeCache.set(key, { at: Date.now(), value });
  return value;
}

/** Each provider's account identity, filled in as sign-in statuses answer. */
export function useAccountIdentities(providers: ProviderConfig[], active = true): Record<string, AccountIdentity> {
  const emails = useAccountEmails(providers);
  const [claude, setClaude] = useState<Record<string, ClaudeCodeStatus | null>>({});
  const claudeIds = providers.filter((p) => p.kind === 'claude-code').map((p) => `${p.id}|${p.claudeCode?.account ?? ''}`).join(',');
  useEffect(() => {
    if (!active || !claudeIds) return;
    let live = true;
    for (const p of providers.filter((x) => x.kind === 'claude-code')) {
      void claudeStatusOf(p).then((s) => { if (live) setClaude((prev) => (prev[p.id] === s ? prev : { ...prev, [p.id]: s })); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeIds, active]);
  return useMemo(() => {
    const raw: Record<string, AccountIdentity> = {};
    for (const p of providers) raw[p.id] = accountIdentity(p, { claude: claude[p.id], email: p.tokenKey ? emails[p.tokenKey] : undefined });
    let out = raw;
    for (const f of accountFamilies(providers)) out = disambiguate(out, f.providers.map((p) => p.id));
    return out;
  }, [providers, claude, emails]);
}

/** "Personal · Max" for a tooltip or a single line. */
export function identityLine(identity: AccountIdentity | undefined): string {
  return identity ? [identity.name, identity.hint].filter(Boolean).join(' · ') : '';
}
