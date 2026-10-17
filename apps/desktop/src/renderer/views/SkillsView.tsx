import React, { useEffect, useMemo, useState } from 'react';
import {
  SKILLS,
  SKILL_CATEGORIES,
  layoutWorkflow,
  NEKKO_SKILLS,
  popularSkills,
  getMarketSkill,
  marketWorkflow,
  marketToSkillDef,
  vaizerToMarketSkill,
  splitSkillMd,
  VAIZER_SITE_URL,
  remoteToMarketSkill,
  matchRemoteSkill,
  skillSources,
  type VaizerCatalog,
  type RemoteSkill,
  type SkillSourceListing,
  type SkillSearchResult,
  type SkillPreview,
  type SkillDef,
  type SkillCategory,
  type SkillNodeKind,
  type SkillWorkflow,
  type LaidOutNode,
  type MarketplaceSkill,
  type InstalledSkillRecord,
  type InstallTargetInfo,
  type InstallTarget,
  type SkillOrigin,
  normalizeInstallTarget,
} from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { StarIcon, SendIcon, CloseIcon, BinocularsIcon, WrenchIcon, BranchIcon, BoltIcon, DownloadIcon, GridIcon } from '../icons.js';
import { hasAppChrome } from '../chrome.js';

/** Per-node-kind visual identity for the workflow canvas. */
const KIND: Record<SkillNodeKind, { color: string; glyph: string; label: string }> = {
  trigger: { color: 'var(--warning)', glyph: '⚡', label: 'Trigger' },
  context: { color: '#6f9bff', glyph: '▤', label: 'Context' },
  agent: { color: '#a78bfa', glyph: '✦', label: 'Agent' },
  tool: { color: 'var(--success)', glyph: '⚙', label: 'Tool' },
  decision: { color: 'var(--highlight)', glyph: '◆', label: 'Decision' },
  loop: { color: '#f472b6', glyph: '↻', label: 'Loop' },
  output: { color: '#34d399', glyph: '✓', label: 'Output' },
};

/** What each node kind means, teaching copy for the explainer panel. */
const KIND_EXPLAIN: Record<SkillNodeKind, string> = {
  trigger: 'Where the run starts: the /command you type (plus any arguments) kicks the skill off.',
  context: 'Gathers what the agent needs before it reasons: files, diffs, search results, inputs.',
  agent: 'A model reasoning step: the agent reads what it has, thinks, and decides or writes something.',
  tool: 'A concrete action in the world: editing a file, running a command, calling git or an API.',
  decision: 'A branch: the agent checks a condition and the run follows the matching labelled arrow.',
  loop: 'A repeating step: work keeps cycling through here until a later check says it is done.',
  output: 'The deliverable: what you get back when the run finishes.',
};

/** Human notes about a node's branches and loops ("yes → Done", "loops back…"). */
function describeEdges(nodeId: string, workflow: SkillWorkflow): string[] {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const notes: string[] = [];
  for (const e of workflow.edges) {
    if (e.from === nodeId) {
      const to = byId.get(e.to);
      if (!to) continue;
      if (e.back) notes.push(`${e.label ? `${e.label}: ` : ''}loops back to “${to.label}”`);
      else if (e.label) notes.push(`${e.label} → “${to.label}”`);
    } else if (e.to === nodeId && e.back) {
      const from = byId.get(e.from);
      if (from) notes.push(`repeats after “${from.label}”`);
    }
  }
  return notes;
}

type Tab = 'library' | 'market';

export function SkillsView() {
  const [tab, setTab] = useState<Tab>('library');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-4 pt-3">
        {(['library', 'market'] as Tab[]).map((k) => (
          <button
            key={k}
            className={`rounded-t-lg border-b-2 px-3.5 py-2 text-[13px] font-medium transition ${
              tab === k ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink'
            }`}
            onClick={() => setTab(k)}
          >
            {k === 'library' ? 'Library' : 'Marketplace'}
          </button>
        ))}
      </div>
      {tab === 'library' ? <LibraryTab /> : <MarketplaceTab />}
    </div>
  );
}

const ORIGIN_TOOL_LABEL: Record<SkillOrigin['tool'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  agents: '.agents',
};

/** Source chip for a skill read from another tool's folder (read-only, not a marketplace install). */
function OriginChip({ origin }: { origin?: SkillOrigin }) {
  if (!origin) return null;
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0 text-[9px]"
      style={{ background: 'var(--surface-2)', color: 'var(--ink-soft)' }}
      title={`Read from ${origin.dir}. Nekko Agent never edits or removes these files.`}
    >
      {ORIGIN_TOOL_LABEL[origin.tool]} · {origin.scope}
    </span>
  );
}

const CATEGORY_ICON: Record<SkillCategory, (p: { className?: string }) => React.ReactElement> = {
  'Research & planning': BinocularsIcon,
  'Code quality': WrenchIcon,
  Delivery: BranchIcon,
  Automation: BoltIcon,
  Imported: DownloadIcon,
};

/** Built-in skills, marketplace skills installed into Nekko Agent, and skills imported read-only from other tools. */
function LibraryTab() {
  const { attachSkillToChat, installedSkillDefs } = useStore(useShallow((s) => ({ attachSkillToChat: s.attachSkillToChat, installedSkillDefs: s.installedSkillDefs })));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SkillCategory | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Marketplace installs only: imported skills belong to the other tool.
  const installedIds = useMemo(() => new Set(installedSkillDefs.filter((s) => !s.origin).map((s) => s.id)), [installedSkillDefs]);
  const all = useMemo(() => {
    const names = new Set(SKILLS.map((s) => s.name));
    return [...SKILLS, ...installedSkillDefs.filter((s) => !names.has(s.name))];
  }, [installedSkillDefs]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [query, all]);
  const categories = SKILL_CATEGORIES.filter((c) => all.some((s) => s.category === c));
  const shown = category === 'all' ? categories : categories.filter((c) => c === category);
  const visible = matching.filter((s) => shown.includes(s.category));

  const selected = selectedId ? all.find((s) => s.id === selectedId) ?? null : null;
  const close = () => setSelectedId(null);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Keep the chosen card visible above the drawer once it opens.
  useEffect(() => {
    if (!selectedId) return;
    const el = document.querySelector(`[data-skill-card="${CSS.escape(selectedId)}"]`);
    requestAnimationFrame(() => el?.scrollIntoView({ block: 'nearest' }));
  }, [selectedId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Card grid */}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-6 pt-5 pb-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              {!hasAppChrome && <h1 className="view-title text-gradient">Skills</h1>}
              <p className="mt-0.5 text-[12.5px] text-ink-faint">
                Ready-made agent workflows. Open one to see how it runs, then use it in a chat.
              </p>
            </div>
            <input
              className="input w-full max-w-xs"
              placeholder="Search skills…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Skill categories">
            {(['all', ...categories] as const).map((c) => {
              const n = c === 'all' ? matching.length : matching.filter((s) => s.category === c).length;
              const on = category === c;
              return (
                <button
                  key={c}
                  role="tab"
                  aria-selected={on}
                  className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                    on ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-soft hover:border-ink-faint hover:text-ink'
                  }`}
                  onClick={() => setCategory(c)}
                >
                  {c === 'all' ? 'All' : c}
                  <span className="ml-1.5 text-[11px] text-ink-faint">{n}</span>
                </button>
              );
            })}
          </div>

          {shown.map((cat) => {
            const items = matching.filter((s) => s.category === cat);
            if (items.length === 0) return null;
            return (
              <section key={cat} className="mt-6">
                <p className="pb-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">{cat}</p>
                <div data-skill-grid className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
                  {items.map((s) => (
                    <SkillCard
                      key={s.id}
                      skill={s}
                      installed={installedIds.has(s.id)}
                      selected={selected?.id === s.id}
                      onOpen={() => setSelectedId(selected?.id === s.id ? null : s.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {visible.length === 0 && <p className="mt-6 text-[12.5px] text-ink-faint">No skills match “{query}”.</p>}
        </div>
      </div>

      {/* Bottom drawer: the selected skill's details + workflow */}
      {selected && (
        <section
          data-skill-drawer
          aria-label={`/${selected.name} workflow`}
          className="slide-up flex h-[58%] min-h-[300px] shrink-0 flex-col border-t border-line bg-surface"
          style={{ boxShadow: '0 -12px 32px -16px rgb(0 0 0 / 0.45)' }}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {selected.highlighted && <StarIcon className="h-4 w-4 text-accent" filled />}
                <h2 className="truncate font-mono text-[16px] font-semibold">/{selected.name}</h2>
                <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--ink-soft)' }}>
                  {selected.category}
                </span>
                {selected.kind === 'goal' && (
                  <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    background agent
                  </span>
                )}
                <OriginChip origin={selected.origin} />
              </div>
              <p className="mt-1 text-[13px] text-ink-soft">{selected.description}</p>
              {selected.origin && (
                <p className="mt-1 truncate text-[11px] text-ink-faint" title={selected.origin.dir}>
                  Folder: <span className="select-text font-mono">{selected.origin.dir}</span>
                </p>
              )}
              {selected.tools && selected.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-ink-faint">Tools:</span>
                  {selected.tools.map((t) => (
                    <span key={t} className="rounded-sm px-1.5 py-0.5 font-mono text-[10.5px]" style={{ background: 'var(--surface-2)', color: 'var(--ink-soft)' }}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                className="btn btn-primary gap-1.5"
                onClick={() => attachSkillToChat(selected)}
                title="Attach this skill to the chat composer"
              >
                <SendIcon className="h-4 w-4" /> Use in chat
              </button>
              <button className="btn btn-ghost h-9 w-9 p-0!" onClick={close} title="Close (Esc)" aria-label="Close workflow">
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          </header>

          <WorkflowExplainer workflow={selected.workflow} />
        </section>
      )}
    </div>
  );
}

/** One skill in the Library grid: category icon, /name, description, and its badges. */
function SkillCard({ skill, installed, selected, onOpen }: { skill: SkillDef; installed: boolean; selected: boolean; onOpen: () => void }) {
  const Icon = CATEGORY_ICON[skill.category] ?? GridIcon;
  return (
    <button
      data-skill-card={skill.id}
      aria-expanded={selected}
      className={`group flex min-h-[132px] flex-col rounded-xl border p-4 text-left transition ${
        selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-ink-faint'
      }`}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${selected ? 'text-accent' : 'text-ink-soft group-hover:text-accent'}`}
          style={{ background: 'var(--surface-2)' }}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className={`truncate font-mono text-[14.5px] font-semibold transition ${selected ? 'text-accent' : 'group-hover:text-accent'}`}>
          /{skill.name}
        </span>
        {skill.highlighted && <StarIcon className="h-3.5 w-3.5 shrink-0 text-accent" filled />}
      </div>
      <p className="mt-3 line-clamp-2 text-[12.5px] leading-snug text-ink-soft">{skill.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        <span className="text-[10.5px] text-ink-faint">{skill.workflow.nodes.length} steps</span>
        {skill.kind === 'goal' && (
          <span className="rounded-full px-1.5 py-0 text-[9px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            background agent
          </span>
        )}
        {installed && <span className="chip px-1.5! py-0! text-[9px]">installed</span>}
        <OriginChip origin={skill.origin} />
      </div>
    </button>
  );
}

// --- Marketplace ---

const SOURCE_META: Record<MarketplaceSkill['source'], { label: string; color: string }> = {
  nekkolabs: { label: 'Nekko Labs', color: 'var(--accent)' },
  community: { label: 'community', color: 'var(--info)' },
  vaizer: { label: 'Vaizer', color: '#a78bfa' },
  github: { label: 'GitHub', color: 'var(--ink-soft)' },
};

/** Trust-tier chip for skills from Vaizer. */
function TierChip({ tier }: { tier?: MarketplaceSkill['tier'] }) {
  if (!tier) return null;
  const official = tier === 'nekko-official';
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0 text-[9px]"
      style={{ background: 'var(--surface-2)', color: official ? '#a78bfa' : 'var(--success)' }}
      title={official ? 'Built and reviewed by Nekko Labs' : 'Community-submitted: audit before use, skills run with your permissions'}
    >
      {official ? '🟣 official' : '🟢 community'}
    </span>
  );
}

function fmtMetric(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

/** Browse + install skills: your installs, Nekko Labs' shelf, and popular online skills. */
function MarketplaceTab() {
  const { attachSkillToChat, installedSkills, refreshSkills, pushToast, settings } = useStore(
    useShallow((s) => ({
      attachSkillToChat: s.attachSkillToChat,
      installedSkills: s.installedSkills,
      refreshSkills: s.refreshSkills,
      pushToast: s.pushToast,
      settings: s.settings,
    })),
  );
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(NEKKO_SKILLS[0]?.id ?? '');
  const [targets, setTargets] = useState<InstallTargetInfo[]>([]);
  const [busy, setBusy] = useState(false);
  // Vaizer hub (optional): renders from the offline snapshot/cache; the
  // network is only touched when the user clicks Refresh.
  const [vaizer, setVaizer] = useState<VaizerCatalog | null>(null);
  const [vaizerBusy, setVaizerBusy] = useState(false);
  // GitHub shelves: shown from the cache; the network is used only on Load /
  // Refresh, Add from GitHub, Search GitHub, and Install.
  const [listings, setListings] = useState<SkillSourceListing[]>([]);
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null);
  // Skills seen in a URL preview or search, kept so they can be selected.
  const [extra, setExtra] = useState<MarketplaceSkill[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState<SkillSearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  const sourcesKey = JSON.stringify(skillSources(settings));
  useEffect(() => {
    window.nekko.listSkillSources?.().then(setListings).catch(() => {});
  }, [sourcesKey]);

  useEffect(() => {
    window.nekko.skillTargets().then(setTargets).catch(() => setTargets([]));
    window.nekko.vaizerCatalog().then(setVaizer).catch(() => {});
    refreshSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A background skills-catalog check (Settings → Updates) lands here as a
  // live catalog the shelf can swap in.
  useEffect(() => window.nekko.onSkillsUpdated(setVaizer), []);

  const refreshVaizer = async () => {
    setVaizerBusy(true);
    try {
      const cat = await window.nekko.vaizerCatalog(true);
      setVaizer(cat);
      pushToast(
        cat.source === 'live' ? 'success' : 'info',
        cat.source === 'live' ? `Vaizer catalog refreshed: ${cat.skills.length} skill(s).` : 'Vaizer unreachable, showing the offline catalog.',
      );
    } finally {
      setVaizerBusy(false);
    }
  };

  const loadSource = async (repo: string) => {
    setLoadingRepo(repo);
    try {
      const next = await window.nekko.listSkillSources(repo);
      setListings(next);
      const hit = next.find((l) => l.source.repo === repo);
      if (hit?.state === 'error') pushToast('error', hit.error ?? `Could not load ${repo}.`);
    } catch (e) {
      pushToast('error', `Could not load ${repo}: ${(e as Error).message}`);
    } finally {
      setLoadingRepo(null);
    }
  };

  const configured = skillSources(settings);
  const setSources = async (next: typeof configured) => {
    try {
      const saved = await window.nekko.updateSettings({ skillSources: next });
      useStore.setState({ settings: saved, settingsError: null });
    } catch (e) {
      pushToast('error', `Could not save shelves: ${(e as Error).message}`);
    }
  };
  const addShelf = async (repo: string) => {
    if (configured.some((c) => c.repo.toLowerCase() === repo.toLowerCase())) return pushToast('info', `${repo} is already a shelf.`);
    await setSources([...configured, { repo }]);
    pushToast('success', `Added ${repo} as a shelf.`);
  };
  const removeShelf = async (repo: string) => {
    await setSources(configured.filter((c) => c.repo !== repo));
    pushToast('info', `Removed the ${repo} shelf. Installed skills stay installed.`);
  };

  const remember = (skills: RemoteSkill[]) => {
    const add = skills.map((r) => remoteToMarketSkill(r));
    setExtra((prev) => [...add, ...prev.filter((p) => !add.some((a) => a.id === p.id))]);
    return add;
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const res = await window.nekko.searchSkills(q);
      remember(res.skills);
      setSearch(res);
    } catch (e) {
      pushToast('error', `GitHub search failed: ${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  };

  const popular = useMemo(() => popularSkills(), []);
  const vaizerSkills = useMemo(() => (vaizer?.skills ?? []).map((d) => vaizerToMarketSkill(d)), [vaizer]);
  const installedBySkill = useMemo(() => {
    const m = new Map<string, InstalledSkillRecord[]>();
    for (const r of installedSkills) m.set(r.skillId, [...(m.get(r.skillId) ?? []), r]);
    return m;
  }, [installedSkills]);

  const matches = (s: MarketplaceSkill) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.author.toLowerCase().includes(q)
    );
  };

  // Every skill we can show, keyed by id: built-in catalog + Vaizer shelf +
  // snapshots carried on installed records (Vaizer installs survive offline).
  const byId = useMemo(() => {
    const m = new Map<string, MarketplaceSkill>();
    for (const r of installedSkills) if (r.skill) m.set(r.skillId, r.skill);
    for (const s of vaizerSkills) m.set(s.id, s);
    for (const l of listings) for (const r of l.skills) if (!m.has(r.id)) m.set(r.id, remoteToMarketSkill(r));
    for (const s of extra) if (!m.has(s.id)) m.set(s.id, s);
    return m;
  }, [installedSkills, vaizerSkills, listings, extra]);
  const resolve = (id: string): MarketplaceSkill | undefined => getMarketSkill(id) ?? byId.get(id);

  const githubShelves = listings.map((l) => ({
    key: `gh:${l.source.repo}`,
    title: l.source.label ?? l.source.repo,
    hint: `github.com/${l.source.repo}${l.stars != null ? ` · ★ ${fmtMetric(l.stars)}` : ''}`,
    items: l.skills.filter((r) => matchRemoteSkill(r, query)).map((r) => byId.get(r.id) ?? remoteToMarketSkill(r)),
    listing: l,
  }));

  const shelves: Array<{ key: string; title: string; hint: string; items: MarketplaceSkill[]; listing?: SkillSourceListing }> = [
    {
      key: 'installed',
      title: 'Installed',
      hint: 'Skills you added, and where they live',
      items: [...installedBySkill.keys()].map(resolve).filter((s): s is MarketplaceSkill => !!s).filter(matches),
    },
    { key: 'nekko-agent', title: 'Nekko Labs', hint: 'First-party skills we maintain', items: NEKKO_SKILLS.filter(matches) },
    { key: 'vaizer', title: 'Vaizer', hint: 'The public skills hub, official + community', items: vaizerSkills.filter(matches) },
    { key: 'popular', title: 'Popular online', hint: 'Ranked by public stars/installs', items: popular.filter(matches) },
    ...githubShelves,
  ];

  const selected = resolve(selectedId) ?? shelves.flatMap((s) => s.items)[0];
  const selectedInstalls = selected ? installedBySkill.get(selected.id) ?? [] : [];

  const install = async (target: InstallTarget) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      // Vaizer skills install their real, current SKILL.md when reachable.
      let payload: MarketplaceSkill | undefined;
      if (selected.source === 'vaizer') {
        const md = await window.nekko.vaizerSkillMd(selected.name).catch(() => null);
        payload = md ? { ...selected, instructions: splitSkillMd(md).body, markdown: md } : selected;
      } else if (selected.source === 'github') {
        // Always the verbatim, current SKILL.md from its own repository.
        if (selected.blocked) {
          pushToast('error', selected.blocked);
          return;
        }
        if (!selected.markdown) {
          const remote = selected.remote;
          if (!remote) throw new Error('Unknown GitHub location.');
          const res = await window.nekko.fetchRemoteSkill({
            id: selected.id,
            name: selected.name,
            description: selected.description,
            sourceUrl: selected.url ?? '',
            license: selected.license,
            extraFiles: selected.extraFiles,
            stars: selected.stars,
            ...remote,
          });
          if (!res.ok) {
            pushToast('error', res.message);
            return;
          }
          payload = res.skill;
        } else payload = selected;
      }
      const res = await window.nekko.installSkill(selected.id, target, payload);
      if (res.ok) {
        pushToast('success', `Installed /${selected.name} to ${targets.find((t) => t.id === target)?.label ?? target}.`);
      } else {
        pushToast('error', res.message ?? 'Install failed.');
      }
      await refreshSkills();
    } catch (e) {
      pushToast('error', `Install failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (target: InstallTarget) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await window.nekko.uninstallSkill(selected.id, target);
      pushToast('info', `Removed /${selected.name} from ${targets.find((t) => t.id === target)?.label ?? target}.`);
      await refreshSkills();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Shelves */}
      <aside className="flex w-80 flex-col border-r border-line">
        <div className="p-4">
          <h1 className="view-title text-gradient">Marketplace</h1>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            Install skills into Nekko Agent, or export them to Claude Code / Codex.
          </p>
          <input
            className="input mt-3"
            placeholder="Search the marketplace…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setSearch(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          />
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <button
              className="text-accent hover:underline disabled:opacity-50"
              disabled={!query.trim() || searching}
              onClick={() => void runSearch()}
              title="Search GitHub for more skills (network)"
            >
              {searching ? 'Searching GitHub…' : 'Search GitHub ↵'}
            </button>
            <button className="text-accent hover:underline" onClick={() => setShowAdd((v) => !v)} aria-expanded={showAdd}>
              {showAdd ? 'Close' : '+ Add from GitHub'}
            </button>
          </div>
          {showAdd && (
            <AddFromGitHub
              shelves={configured.map((c) => c.repo.toLowerCase())}
              onAddShelf={(repo) => void addShelf(repo)}
              onFound={(skills) => {
                const added = remember(skills);
                if (added[0]) setSelectedId(added[0].id);
              }}
            />
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {search && (
            <SearchResults
              result={search}
              selectedId={selected?.id}
              resolve={resolve}
              onSelect={setSelectedId}
              onOpenRepo={async (repo) => {
                const res = await window.nekko.previewSkillUrl(repo);
                if (!res.ok) return pushToast('error', res.message ?? `No skills found in ${repo}.`);
                const added = remember(res.skills);
                if (added[0]) setSelectedId(added[0].id);
                setSearch((prev) => (prev ? { ...prev, skills: [...res.skills, ...prev.skills.filter((p) => !res.skills.some((r) => r.id === p.id))] } : prev));
              }}
              onClose={() => setSearch(null)}
            />
          )}
          {shelves.map((shelf) => (
            <div key={shelf.key} className="mb-4">
              <div className="flex items-center justify-between px-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{shelf.title}</p>
                {shelf.key === 'vaizer' && (
                  <span className="flex items-center gap-2">
                    <button
                      className="text-[10px] text-accent hover:underline disabled:opacity-50"
                      disabled={vaizerBusy}
                      onClick={() => void refreshVaizer()}
                      title="Fetch the latest catalog from Vaizer (network)"
                    >
                      {vaizerBusy ? 'Refreshing…' : '↻ Refresh'}
                    </button>
                    <button
                      className="text-[10px] text-accent hover:underline"
                      onClick={() => window.nekko.openPath(VAIZER_SITE_URL)}
                      title="Browse the Vaizer skills catalog at vaizer.app"
                    >
                      Browse ↗
                    </button>
                  </span>
                )}
                {shelf.listing && (
                  <span className="flex items-center gap-2">
                    <button
                      className="text-[10px] text-accent hover:underline disabled:opacity-50"
                      disabled={loadingRepo !== null}
                      onClick={() => void loadSource(shelf.listing!.source.repo)}
                      title={`Fetch the skills in ${shelf.listing.source.repo} from GitHub (network)`}
                    >
                      {loadingRepo === shelf.listing.source.repo ? 'Loading…' : shelf.listing.state === 'none' ? '⤓ Load' : '↻ Refresh'}
                    </button>
                    <button
                      className="text-[10px] text-accent hover:underline"
                      onClick={() => window.nekko.openPath(`https://github.com/${shelf.listing!.source.repo}`)}
                      title={`Open ${shelf.listing.source.repo} on GitHub`}
                    >
                      ↗
                    </button>
                    <button
                      className="text-[10px] text-ink-faint hover:text-ink"
                      onClick={() => void removeShelf(shelf.listing!.source.repo)}
                      title="Remove this shelf (installed skills stay installed)"
                      aria-label={`Remove the ${shelf.listing.source.repo} shelf`}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
              <p className="px-2 pb-1 text-[10.5px] text-ink-faint">
                {shelf.hint}
                {shelf.key === 'vaizer' && vaizer && (
                  <span> · {vaizer.source === 'live' ? 'live' : vaizer.source === 'cached' ? 'cached' : 'offline snapshot'}</span>
                )}
                {shelf.listing && shelf.listing.state !== 'none' && (
                  <span> · {shelf.listing.state === 'error' ? 'could not refresh' : shelf.listing.state} · {shelf.listing.skills.length} skills</span>
                )}
              </p>
              {shelf.items.length === 0 && (
                <p className="px-2 py-1 text-[11.5px] text-ink-faint">
                  {shelf.key === 'installed'
                    ? 'Nothing installed yet, pick a skill below.'
                    : shelf.listing?.state === 'none'
                      ? 'Not loaded yet. Load reads this repository from GitHub.'
                      : 'No matches.'}
                </p>
              )}
              <div className="space-y-1">
                {shelf.items.map((s) => {
                  const installs = installedBySkill.get(s.id) ?? [];
                  return (
                    <button
                      key={`${shelf.key}:${s.id}`}
                      className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                        selected?.id === s.id ? 'border-accent' : 'border-transparent hover:bg-surface-2'
                      }`}
                      onClick={() => setSelectedId(s.id)}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate font-mono text-[13px] font-medium">/{s.name}</span>
                        <span className="shrink-0 rounded-full px-1.5 py-0 text-[9px]" style={{ background: 'var(--surface-2)', color: SOURCE_META[s.source].color }}>
                          {SOURCE_META[s.source].label}
                        </span>
                        {s.source !== 'github' && <TierChip tier={s.tier} />}
                        {s.blocked && <span className="shrink-0 text-[9px] text-ink-faint" title={s.blocked}>link only</span>}
                        {installs.length > 0 && <span className="chip px-1.5! py-0! text-[9px]">✓ {installs.length}</span>}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-soft">{s.description}</p>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-faint">
                        <span>{s.author}</span>
                        {s.stars != null && <span>★ {fmtMetric(s.stars)}</span>}
                        {s.installs != null && <span>⤓ {fmtMetric(s.installs)}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Detail */}
      {selected && (
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-line p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-mono text-[16px] font-semibold">/{selected.name}</h2>
                  <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--ink-soft)' }}>
                    {selected.category}
                  </span>
                  <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--surface-2)', color: SOURCE_META[selected.source].color }}>
                    {SOURCE_META[selected.source].label}
                  </span>
                  <TierChip tier={selected.tier} />
                </div>
                <p className="mt-1 text-[13px] text-ink-soft">{selected.description}</p>
                {selected.tier === 'community' && !selected.blocked && (
                  <p className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
                    {selected.source === 'github'
                      ? "From GitHub, not reviewed by Nekko Labs: it runs with your machine's permissions. Read its instructions before installing."
                      : "Community skill: it runs with your machine's permissions. Read its instructions before installing."}
                  </p>
                )}
                {selected.blocked && (
                  <p className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ background: 'var(--surface-2)', color: 'var(--ink-soft)' }}>
                    {selected.blocked} Open it on GitHub to use it from its source.
                  </p>
                )}
                {selected.extraFiles && !selected.blocked && (
                  <p className="mt-1.5 text-[11px] text-ink-faint">
                    This skill's folder also ships scripts or reference files. Only SKILL.md is installed, so steps that rely on those files may not work.
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                  <span>by {selected.author}</span>
                  {selected.license && <span>license: {selected.license}</span>}
                  {selected.stars != null && <span>★ {fmtMetric(selected.stars)} stars</span>}
                  {selected.installs != null && <span>⤓ {fmtMetric(selected.installs)} installs</span>}
                  {selected.url && (
                    <button className="text-accent hover:underline" onClick={() => window.nekko.openPath(selected.url!)}>
                      {selected.url.replace(/^https?:\/\//, '')} ↗
                    </button>
                  )}
                  {selected.basedOn && (
                    <span>
                      based on{' '}
                      <button className="text-accent hover:underline" onClick={() => window.nekko.openPath(selected.basedOn!)}>
                        {selected.basedOn.replace(/^https?:\/\//, '')} ↗
                      </button>
                    </span>
                  )}
                </div>
                {selected.tools && selected.tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-ink-faint">Tools:</span>
                    {selected.tools.map((t) => (
                      <span key={t} className="rounded-sm px-1.5 py-0.5 font-mono text-[10.5px]" style={{ background: 'var(--surface-2)', color: 'var(--ink-soft)' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {selectedInstalls.some((r) => normalizeInstallTarget(r.target) === 'nekko-agent') && (
                <button
                  className="btn btn-primary shrink-0 gap-1.5"
                  // Prefer the installed snapshot: a Vaizer install carries the
                  // SKILL.md it was installed with, the shelf entry does not.
                  onClick={() => {
                    const rec = selectedInstalls.find((r) => normalizeInstallTarget(r.target) === 'nekko-agent');
                    attachSkillToChat(marketToSkillDef(rec?.skill ?? selected));
                  }}
                  title="Attach this skill to the chat composer"
                >
                  <SendIcon className="h-4 w-4" /> Use in chat
                </button>
              )}
            </div>

            {/* Install targets */}
            <div className="mt-3 flex flex-wrap gap-2">
              {targets.map((t) => {
                const installed = selectedInstalls.some((r) => r.target === t.id);
                return (
                  <div key={t.id} className="flex items-center gap-1.5 rounded-xl border border-line px-2.5 py-1.5">
                    <span className="text-[12px] font-medium">{t.label}</span>
                    <span className="text-[10px] text-ink-faint" title={t.dir ?? ''}>{t.hint}</span>
                    {installed ? (
                      <button className="btn btn-ghost px-2! py-0.5! text-[11px] text-red-400" disabled={busy} onClick={() => uninstall(t.id)}>
                        Remove
                      </button>
                    ) : selected.blocked ? (
                      <span className="text-[10px] text-ink-faint" title={selected.blocked}>link only</span>
                    ) : t.available ? (
                      <button className="btn btn-outline px-2! py-0.5! text-[11px]" disabled={busy} onClick={() => install(t.id)}>
                        Install
                      </button>
                    ) : (
                      <span className="text-[10px] text-ink-faint" title="App folder not found on this machine">not detected</span>
                    )}
                  </div>
                );
              })}
            </div>
          </header>

          <WorkflowExplainer workflow={marketWorkflow(selected)}>
            <div className="card mt-6 max-w-2xl p-4">
              <p className="text-[12px] font-medium">What it tells the agent</p>
              {selected.source === 'github' && !selected.markdown ? (
                <RemoteInstructions skill={selected} />
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-soft">{selected.instructions}</p>
              )}
            </div>
          </WorkflowExplainer>
        </section>
      )}
    </div>
  );
}

/** Paste a GitHub URL or owner/repo and list the skills it holds (nothing is installed). */
function AddFromGitHub({
  onFound,
  shelves,
  onAddShelf,
}: {
  onFound: (skills: RemoteSkill[]) => void;
  shelves: string[];
  onAddShelf: (repo: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SkillPreview | null>(null);
  const go = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      const res = await window.nekko.previewSkillUrl(url.trim());
      setResult(res);
      if (res.ok) onFound(res.skills);
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message, skills: [] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 rounded-lg border border-line p-2.5">
      <p className="text-[11px] text-ink-faint">A skill folder or a whole repository. You see it before anything is installed.</p>
      <div className="mt-1.5 flex gap-1.5">
        <input
          className="input flex-1 text-[12px]"
          placeholder="github.com/owner/repo/tree/main/skills/name"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void go();
          }}
          aria-label="GitHub URL or owner/repo"
        />
        <button className="btn btn-outline px-2! py-0.5! text-[11px]" disabled={busy || !url.trim()} onClick={() => void go()}>
          {busy ? '…' : 'Find'}
        </button>
      </div>
      {result && (
        <p className="mt-1.5 text-[11px]" style={{ color: result.ok ? 'var(--ink-soft)' : 'var(--danger, #f87171)' }} role="status">
          {result.ok ? `${result.skills.length} skill${result.skills.length === 1 ? '' : 's'} found in ${result.repo}.` : result.message}
        </p>
      )}
      {result?.ok && result.skills.length > 1 && (
        <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
          {result.skills.map((r) => (
            <button key={r.id} className="chip px-1.5! py-0! font-mono text-[10.5px]" onClick={() => onFound([r])} title={r.description}>
              /{r.name}
            </button>
          ))}
        </div>
      )}
      {result?.ok && result.repo && !shelves.includes(result.repo.toLowerCase()) && (
        <button className="mt-1 text-[11px] text-accent hover:underline" onClick={() => onAddShelf(result.repo!)}>
          + Keep {result.repo} as a shelf
        </button>
      )}
    </div>
  );
}

/** GitHub search results: skills (with a token) or repositories that may hold skills. */
function SearchResults({
  result,
  selectedId,
  resolve,
  onSelect,
  onOpenRepo,
  onClose,
}: {
  result: SkillSearchResult;
  selectedId?: string;
  resolve: (id: string) => MarketplaceSkill | undefined;
  onSelect: (id: string) => void;
  onOpenRepo: (repo: string) => Promise<void>;
  onClose: () => void;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Search results · GitHub</p>
        <button className="text-[10px] text-accent hover:underline" onClick={onClose}>
          Clear
        </button>
      </div>
      {result.note && <p className="px-2 pb-1 text-[10.5px] text-ink-faint">{result.note}</p>}
      {result.skills.length === 0 && result.repos.length === 0 && <p className="px-2 py-1 text-[11.5px] text-ink-faint">Nothing found.</p>}
      <div className="space-y-1">
        {result.skills.map((r) => {
          const s = resolve(r.id);
          return (
            <button
              key={r.id}
              className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${selectedId === r.id ? 'border-accent' : 'border-transparent hover:bg-surface-2'}`}
              onClick={() => onSelect(r.id)}
            >
              <span className="font-mono text-[13px] font-medium">/{r.name}</span>
              <p className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-soft">{s?.description || r.description || r.sourceUrl.replace(/^https:\/\//, '')}</p>
              <p className="mt-1 text-[10px] text-ink-faint">{r.repo}</p>
            </button>
          );
        })}
        {result.repos.map((r) => (
          <div key={r.repo} className="rounded-lg px-2.5 py-2 hover:bg-surface-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[12.5px] font-medium">{r.repo}</span>
              <button
                className="shrink-0 text-[10.5px] text-accent hover:underline disabled:opacity-50"
                disabled={opening !== null}
                onClick={async () => {
                  setOpening(r.repo);
                  try {
                    await onOpenRepo(r.repo);
                  } finally {
                    setOpening(null);
                  }
                }}
              >
                {opening === r.repo ? 'Reading…' : 'List skills'}
              </button>
            </div>
            {r.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-soft">{r.description}</p>}
            {r.stars != null && <p className="mt-0.5 text-[10px] text-ink-faint">★ {fmtMetric(r.stars)}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A GitHub skill's instructions, fetched from its repository when it is opened. */
function RemoteInstructions({ skill }: { skill: MarketplaceSkill }) {
  const [state, setState] = useState<{ id: string; text?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!skill.remote || skill.blocked) return;
    let live = true;
    setState({ id: skill.id });
    window.nekko
      .fetchRemoteSkill({ id: skill.id, name: skill.name, description: skill.description, sourceUrl: skill.url ?? '', ...skill.remote })
      .then((res) => live && setState(res.ok ? { id: skill.id, text: res.skill.instructions } : { id: skill.id, error: res.message }))
      .catch((e) => live && setState({ id: skill.id, error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [skill.id, skill.blocked]);
  if (skill.blocked) return <p className="mt-1 text-[12px] text-ink-faint">Not shown: {skill.blocked}</p>;
  if (!state || state.id !== skill.id || (!state.text && !state.error)) return <p className="mt-1 text-[12px] text-ink-faint">Reading SKILL.md from GitHub…</p>;
  if (state.error) return <p className="mt-1 text-[12px] text-ink-faint">{state.error}</p>;
  return <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-soft">{state.text}</p>;
}

/**
 * The workflow area: the node canvas plus a side panel that explains the graph.
 * With nothing selected the panel walks the steps in run order; clicking a node
 * (on the canvas or in the list) explains that step, its kind, and its branches.
 */
function WorkflowExplainer({ workflow, children }: { workflow: SkillWorkflow; children?: React.ReactNode }) {
  const [selId, setSelId] = useState<string | null>(null);
  useEffect(() => setSelId(null), [workflow]);

  const layout = useMemo(() => layoutWorkflow(workflow), [workflow]);
  const ordered = useMemo(
    () => [...layout.nodes].sort((a, b) => a.layer - b.layer || a.row - b.row),
    [layout],
  );
  const selNode = ordered.find((n) => n.id === selId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <p className="text-[12px] font-medium text-ink-soft">Workflow</p>
        <Legend />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto p-6" style={{ background: 'var(--paper)' }}>
          <WorkflowCanvas workflow={workflow} selectedId={selId} onSelect={(id) => setSelId(id === selId ? null : id)} />
          {children}
        </div>

        {/* Explainer panel */}
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-line p-4">
          {selNode ? (
            <div className="fade-in">
              <button className="text-[11px] text-ink-faint hover:text-ink" onClick={() => setSelId(null)}>
                ← All steps
              </button>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-base" style={{ color: KIND[selNode.kind].color }}>{KIND[selNode.kind].glyph}</span>
                <h3 className="text-[14px] font-semibold">{selNode.label}</h3>
              </div>
              <span
                className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ background: 'var(--surface-2)', color: KIND[selNode.kind].color }}
              >
                {KIND[selNode.kind].label} step
              </span>
              {selNode.detail && <p className="mt-2 text-[12.5px] text-ink-soft">{selNode.detail}</p>}
              <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">{KIND_EXPLAIN[selNode.kind]}</p>
              {describeEdges(selNode.id, workflow).length > 0 && (
                <div className="mt-3">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Where it goes</p>
                  <ul className="mt-1 space-y-1">
                    {describeEdges(selNode.id, workflow).map((n, i) => (
                      <li key={i} className="text-[12px] text-ink-soft">{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">How this skill runs</h3>
              <p className="mt-1 text-[11.5px] text-ink-faint">Click any step, here or on the canvas, to see what it does.</p>
              <ol className="mt-3 space-y-1.5">
                {ordered.map((n, i) => (
                  <li key={n.id}>
                    <button
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-2"
                      onClick={() => setSelId(n.id)}
                    >
                      <span
                        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                        style={{ background: KIND[n.kind].color }}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[12.5px] font-medium">{n.label}</span>
                        <span className="block text-[11px] text-ink-faint">
                          {n.detail || KIND[n.kind].label}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Legend() {
  const kinds: SkillNodeKind[] = ['trigger', 'context', 'agent', 'tool', 'decision', 'loop', 'output'];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {kinds.map((k) => (
        <span key={k} className="flex items-center gap-1 text-[10.5px] text-ink-faint">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND[k].color }} />
          {KIND[k].label}
        </span>
      ))}
    </div>
  );
}

/** n8n / Make-style node-graph rendering of a skill's workflow. */
function WorkflowCanvas({
  workflow,
  selectedId,
  onSelect,
}: {
  workflow: SkillWorkflow;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const layout = useMemo(() => layoutWorkflow(workflow), [workflow]);
  const { nodes, edges, width, height, nodeW, nodeH } = layout;
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <div
      className="relative"
      style={{
        width,
        height,
        minWidth: width,
        // Subtle dotted grid like a node-editor canvas.
        backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)',
        backgroundSize: '16px 16px',
      }}
    >
      <svg width={width} height={height} className="absolute inset-0" style={{ overflow: 'visible' }}>
        <defs>
          <marker id="op-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-faint)" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const { d, lx, ly } = edgePath(a, b, nodeW, nodeH, e.back);
          return (
            <g key={i}>
              <path
                d={d}
                fill="none"
                stroke="var(--ink-faint)"
                strokeWidth={1.5}
                strokeDasharray={e.back ? '4 4' : undefined}
                markerEnd="url(#op-arrow)"
                opacity={e.back ? 0.7 : 0.9}
              />
              {e.label && (
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  className="select-none"
                  style={{ fontSize: 10, fill: 'var(--ink-soft)' }}
                >
                  <tspan dy="-2" style={{ paintOrder: 'stroke' as const }}>
                    {e.label}
                  </tspan>
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {nodes.map((n) => (
        <NodeCard key={n.id} node={n} w={nodeW} h={nodeH} selected={selectedId === n.id} onSelect={onSelect} />
      ))}
    </div>
  );
}

function NodeCard({
  node, w, h, selected, onSelect,
}: {
  node: LaidOutNode; w: number; h: number; selected?: boolean; onSelect?: (id: string) => void;
}) {
  const k = KIND[node.kind];
  return (
    <button
      className="card absolute flex flex-col justify-center overflow-hidden px-3 py-2 text-left shadow-xs transition"
      style={{
        left: node.x,
        top: node.y,
        width: w,
        height: h,
        borderLeft: `3px solid ${k.color}`,
        cursor: onSelect ? 'pointer' : 'default',
        boxShadow: selected ? `0 0 0 2px ${k.color}` : undefined,
      }}
      title={node.detail}
      onClick={() => onSelect?.(node.id)}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: k.color }}>{k.glyph}</span>
        <span className="truncate text-[12.5px] font-medium leading-tight">{node.label}</span>
      </div>
      {node.detail && <p className="mt-0.5 truncate text-[10.5px] text-ink-faint">{node.detail}</p>}
    </button>
  );
}

/** Bezier path between two node boxes; forward edges go right, back edges loop under. */
function edgePath(a: LaidOutNode, b: LaidOutNode, w: number, h: number, back?: boolean) {
  if (back) {
    // Loop edge: leave the source's bottom, dip below, re-enter the target's bottom.
    const sx = a.x + w / 2;
    const sy = a.y + h;
    const tx = b.x + w / 2;
    const ty = b.y + h;
    const dip = Math.max(sy, ty) + 46;
    return {
      d: `M ${sx} ${sy} C ${sx} ${dip}, ${tx} ${dip}, ${tx} ${ty}`,
      lx: (sx + tx) / 2,
      ly: dip - 6,
    };
  }
  const sx = a.x + w;
  const sy = a.y + h / 2;
  const tx = b.x;
  const ty = b.y + h / 2;
  const dx = Math.max(28, (tx - sx) / 2);
  return {
    d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
    lx: (sx + tx) / 2,
    ly: (sy + ty) / 2 - 4,
  };
}
