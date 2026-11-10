import React, { useEffect, useMemo, useState } from 'react';
import type { ModelInfo, ProviderConfig, SubscriptionLimits } from '@nekko-agent/shared';
import { formatModelPriceLabel, isLocalProvider, limitsKeyFor, modelPricing } from '@nekko-agent/shared';
import { useProviderLimitsPortfolio } from '../useLimits.js';
import { useStore } from '../store.js';
import { Group, Row, StatusDot, Toggle } from '../components/primitives/index.js';
import { accountFamilies, identityLine, sharedEmail, useAccountIdentities, type AccountFamily, type AccountIdentity } from '../providerAccounts.js';
import { ProviderMark, providerMarkKind } from '../components/providers/ProviderMark.js';
import type { ProviderSetupKind } from '../components/providers/providerPresets.js';
import { matchesModelQuery } from '../components/agent-console/modelPickerInteractions.js';
import { MODEL_FILTER_THRESHOLD } from './modelListProblem.js';
import { ContextMenu, ContextAction } from '../components/ContextMenu.js';
import { ChevronIcon, StarIcon } from '../icons.js';

/**
 * The cloud half of the Models page as families: each one (Claude, OpenAI, ...)
 * lists the accounts that come with it, then the models those accounts offer,
 * each naming which accounts have it. One login with a personal plan and an
 * organization seat reads as two accounts under one heading, with the email
 * once. An account's sign-in and connection controls open under its row.
 * Quiet surfaces: no cards; families are told apart by space and heading
 * size, in a responsive grid of up to three columns (docs/design-system.md).
 */
export function ProviderFamilies({ providers, onAdd, renderDetails }: {
  providers: ProviderConfig[];
  /** Open setup on the kind that adds another account to a family. */
  onAdd: (kind: ProviderSetupKind) => void;
  /** An account's own controls (sign-in, connection, usage), shown when its row is open. */
  renderDetails: (provider: ProviderConfig) => React.ReactNode;
}) {
  const cloud = useMemo(() => providers.filter((p) => !isLocalProvider(p.kind)), [providers]);
  const families = useMemo(() => accountFamilies(cloud), [cloud]);
  const identities = useAccountIdentities(cloud);
  // Each plan's live usage, so the busiest window reads on its account row.
  const { byToken: limits } = useProviderLimitsPortfolio(cloud, true);
  return (
    <div className="provider-families" data-provider-families>
      {families.map((f) => (
        <FamilySection key={f.id} family={f} identities={identities} limits={limits} onAdd={onAdd} renderDetails={renderDetails} />
      ))}
    </div>
  );
}

/** Which setup adds another account to a family. */
export function addKindFor(family: AccountFamily): ProviderSetupKind {
  if (family.id === 'claude') return 'anthropic';
  if (family.id === 'openai') return family.providers.some((p) => p.kind === 'chatgpt') ? 'chatgpt' : 'openai';
  if (family.id === 'gemini') return 'gemini';
  if (family.id === 'ollama-cloud') return 'ollama-cloud';
  if (family.id === 'openrouter') return 'openrouter';
  return 'openai-compat';
}

type Health = 'checking' | 'ok' | 'fail' | 'off';

function FamilySection({ family, identities, limits, onAdd, renderDetails }: {
  family: AccountFamily;
  identities: Record<string, AccountIdentity>;
  limits: Record<string, SubscriptionLimits | undefined>;
  onAdd: (kind: ProviderSetupKind) => void;
  renderDetails: (provider: ProviderConfig) => React.ReactNode;
}) {
  const idOf = (p: ProviderConfig): AccountIdentity => identities[p.id] ?? { name: p.label };
  const email = sharedEmail(family.providers.map(idOf));
  const several = family.providers.length > 1;
  const [open, setOpen] = useState<string | null>(null);
  const markKind = providerMarkKind(family.providers[0]);
  const custom = family.id.startsWith('provider:');
  return (
    <section className="min-w-0" aria-label={family.name} data-provider-family={family.id}>
      <div className="mb-4 flex min-w-0 items-center gap-3">
        <ProviderMark kind={markKind} tile />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{family.name}</h3>
          <p className="truncate text-xs text-ink-faint" data-family-summary>
            {[accountCount(family), email].filter(Boolean).join(' · ')}
          </p>
        </div>
        {!custom && <button type="button" className="btn btn-ghost ml-auto px-3 text-xs" onClick={() => onAdd(addKindFor(family))} title={`Connect another ${family.name} account: an organization seat, another plan, or an API key`}>
          + Add account
        </button>}
      </div>
      <Group title={<span className="quiet-group-label">Accounts</span>} className="mb-6">
        {family.providers.map((p) => (
          <AccountRow
            key={p.id}
            provider={p}
            identity={idOf(p)}
            sharedEmail={email}
            limits={limits[limitsKeyFor(p) ?? '']}
            open={open === p.id}
            onToggleOpen={() => setOpen((cur) => (cur === p.id ? null : p.id))}
            details={open === p.id ? renderDetails(p) : null}
          />
        ))}
      </Group>
      <FamilyModels family={family} identities={identities} several={several} />
    </section>
  );
}

/** "2 accounts" or "1 account". */
function accountCount(family: AccountFamily): string {
  const n = family.providers.length;
  return `${n} account${n === 1 ? '' : 's'}`;
}

/** The usage window closest to its limit, as "5 hours 62%", or null when none is reported. */
export function busiestWindow(limits?: SubscriptionLimits): { text: string; tone: 'warning' | 'danger' | null } | null {
  const w = limits?.windows.filter((x) => Number.isFinite(x.usedPercent)).sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!w) return null;
  return { text: `${w.label} ${Math.round(w.usedPercent)}%`, tone: w.status === 'rate_limited' ? 'danger' : w.status === 'warning' ? 'warning' : null };
}

function AccountRow({ provider, identity, sharedEmail: loginEmail, limits, open, onToggleOpen, details }: {
  provider: ProviderConfig;
  identity: AccountIdentity;
  limits?: SubscriptionLimits;
  /** The family's login email, already shown once in its summary. */
  sharedEmail?: string;
  open: boolean;
  onToggleOpen: () => void;
  details: React.ReactNode;
}) {
  const refreshProviders = useStore((s) => s.refreshProviders);
  const enabled = provider.enabled !== false;
  const [health, setHealth] = useState<Health>(enabled ? 'checking' : 'off');
  const [message, setMessage] = useState<string | undefined>();
  useEffect(() => {
    if (!enabled) { setHealth('off'); return; }
    let live = true;
    setHealth('checking');
    void window.nekko.testProvider(provider.id)
      .then((r) => { if (live) { setHealth(r.ok ? 'ok' : 'fail'); setMessage(r.message); } })
      .catch((e) => { if (live) { setHealth('fail'); setMessage(String(e)); } });
    return () => { live = false; };
  }, [provider.id, provider.tokenKey, enabled]);
  const status = !enabled ? { tone: 'neutral' as const, word: 'Off' }
    : identity.signedOut ? { tone: 'warning' as const, word: 'Signed out' }
    : health === 'fail' ? { tone: 'danger' as const, word: 'Offline' }
    : health === 'ok' ? { tone: 'success' as const, word: 'Connected' }
    : { tone: 'neutral' as const, word: 'Checking…' };
  const setEnabled = async (next: boolean) => {
    await window.nekko.saveProvider({ ...provider, enabled: next });
    refreshProviders();
  };
  const usage = enabled ? busiestWindow(limits) : null;
  const words = [identity.hint, identity.email && identity.email.toLowerCase() !== loginEmail?.toLowerCase() ? identity.email : ''].filter(Boolean).join(' · ');
  const detail = usage ? <>{words}{words ? ' · ' : ''}<span style={usage.tone ? { color: `var(--${usage.tone})` } : undefined} data-account-usage>{usage.text}</span></> : words;
  return (
    <div className="min-w-0" id={`provider-${provider.id}`} data-account-row={provider.id}>
      <Row
        leading={<StatusDot tone={status.tone} size={8} title={status.word} />}
        title={identity.name}
        detail={detail || undefined}
        meta={<span className="inline-flex items-center gap-2"><span style={status.tone === 'danger' || status.tone === 'warning' ? { color: `var(--${status.tone})` } : undefined} title={status.tone === 'danger' ? message : undefined}>{status.word}</span><ChevronIcon className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} aria-hidden="true" /></span>}
        onClick={onToggleOpen}
        aria-expanded={open}
        titleClassName={enabled ? '' : 'text-ink-faint'}
        trailing={<span className="flex items-center gap-1 pl-2">
          <Toggle value={enabled} onChange={(v) => void setEnabled(v)} label={`${enabled ? 'Turn off' : 'Turn on'} ${identityLine(identity)}`} title={enabled ? 'On: listed in model pickers and usable in chats' : 'Off: never contacted, hidden from model pickers'} />
        </span>}
      />
      {open && <div className="pb-4 pl-8 pr-3 pt-1" data-account-details>{details}</div>}
    </div>
  );
}

interface MergedModel { id: string; name: string; offeredBy: ProviderConfig[]; sample: ModelInfo }

/** Every model the family's accounts offer, once, with the accounts that have it. */
function FamilyModels({ family, identities, several }: { family: AccountFamily; identities: Record<string, AccountIdentity>; several: boolean }) {
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const pushToast = useStore((s) => s.pushToast);
  const enabled = family.providers.filter((p) => p.enabled !== false);
  const [lists, setLists] = useState<Record<string, ModelInfo[] | null>>({});
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; m: MergedModel } | null>(null);
  const key = enabled.map((p) => `${p.id}:${p.tokenKey ?? ''}`).join('|');
  useEffect(() => {
    let live = true;
    for (const p of enabled) {
      void window.nekko.listModels(p.id).then((m) => m, () => null).then((m) => { if (live) setLists((prev) => ({ ...prev, [p.id]: m })); });
    }
    const off = window.nekko.onModelsUpdated?.((e) => {
      const p = enabled.find((x) => x.id === e.providerId);
      if (p) void window.nekko.listModels(p.id).then((m) => { if (live) setLists((prev) => ({ ...prev, [p.id]: m })); }, () => {});
    });
    return () => { live = false; off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const merged = useMemo(() => {
    const byId = new Map<string, MergedModel>();
    for (const p of enabled) {
      for (const m of lists[p.id] ?? []) {
        const hit = byId.get(m.id);
        if (hit) hit.offeredBy.push(p);
        else byId.set(m.id, { id: m.id, name: m.name, offeredBy: [p], sample: m });
      }
    }
    return [...byId.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists, key]);
  const loading = enabled.some((p) => lists[p.id] === undefined);
  const filtering = merged.length > MODEL_FILTER_THRESHOLD;
  const shown = merged.filter((m) => !filtering || matchesModelQuery(m.sample, query));
  const favs = new Set(settings?.favoriteModels ?? []);
  const keysOf = (m: MergedModel) => m.offeredBy.map((p) => `${p.id}::${m.id}`);
  // One star pins the model on every account that offers it.
  const toggleStar = async (m: MergedModel) => {
    const keys = keysOf(m);
    const on = keys.some((k) => favs.has(k));
    const next = new Set(favs);
    for (const k of keys) { if (on) next.delete(k); else next.add(k); }
    await window.nekko.updateSettings({ favoriteModels: [...next] });
    refreshSettings();
  };
  const setDefault = (p: ProviderConfig, m: MergedModel) => {
    void window.nekko.updateSettings({ defaultProviderId: p.id, defaultModelId: m.id }).then(() => refreshSettings()).catch((e) => pushToast('error', String(e)));
  };
  const nameOf = (p: ProviderConfig) => identities[p.id]?.name ?? p.label;
  const isDefault = (m: MergedModel) => m.offeredBy.some((p) => settings?.defaultProviderId === p.id && settings?.defaultModelId === m.id);
  if (!enabled.length) return null;
  return (
    <Group
      title={<span className="quiet-group-label">Models</span>}
      meta={merged.length ? String(merged.length) : undefined}
      data-family-models
    >
      {filtering && <input className="quiet-field mb-2 text-xs" placeholder={`Search ${family.name} models`} aria-label={`Search ${family.name} models`} value={query} onChange={(e) => setQuery(e.target.value)} />}
      {!merged.length && <p className="px-3 py-2 text-xs text-ink-faint">{loading ? 'Loading models…' : 'No models reported yet. Open an account above to check its connection.'}</p>}
      {merged.length > 0 && !shown.length && <p className="px-3 py-2 text-xs text-ink-faint">No models match.</p>}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        {menu.m.offeredBy.map((p) => <ContextAction key={p.id} onClick={() => { setDefault(p, menu.m); setMenu(null); }}>{menu.m.offeredBy.length > 1 ? `Set as default on ${nameOf(p)}` : 'Set as default'}</ContextAction>)}
      </ContextMenu>}
      <div className="max-h-96 overflow-y-auto overscroll-contain">
        {shown.map((m) => {
          const first = m.offeredBy[0];
          const price = formatModelPriceLabel({ modelId: m.id, auth: first.auth, isLocal: false, pricing: modelPricing(m.sample) });
          const starred = keysOf(m).some((k) => favs.has(k));
          return (
            <div key={m.id} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, m }); }} data-family-model={m.id}>
              <Row
                dense
                title={m.name}
                detail={several ? m.offeredBy.map(nameOf).join(' · ') : undefined}
                meta={isDefault(m) ? <span className="text-accent">Default</span> : price || undefined}
                trailing={<button
                  type="button"
                  className={`rounded-md p-2 ${starred ? 'text-accent' : 'text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 touch:opacity-100'}`}
                  aria-pressed={starred}
                  aria-label={starred ? `Unstar ${m.name}` : `Star ${m.name}`}
                  title={starred ? 'Unstar' : several ? 'Star (pin to the top of the model picker on every account that offers it)' : 'Star (pin to the top of the model picker)'}
                  onClick={() => void toggleStar(m)}
                >
                  <StarIcon className="h-3.5 w-3.5" filled={starred} />
                </button>}
              />
            </div>
          );
        })}
      </div>
    </Group>
  );
}
