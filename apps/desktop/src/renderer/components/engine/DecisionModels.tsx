import { useEffect, useState } from 'react';
import type {
  DecisionAnswer,
  DecisionCatalogEntry,
  DecisionPrecision,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionStatus,
  InstalledDecisionModel,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { formatBytes } from '../runtimes/verdict.js';

const EXAMPLE_STATE = 'Hi, I was charged twice for my March invoice and the second charge still has not been refunded after a week. Please fix this today.';
const EXAMPLE_QUESTIONS = JSON.stringify({
  department: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'Payments, refunds and invoices', technical: 'Bugs and outages', account: 'Login and profile' } },
  urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['low', 'medium', 'high'] },
  refund: { type: 'noul', instructions: 'The customer is asking for money back.' },
}, null, 2);

/**
 * Decision models in Nekko Server: fetch and run Laya locally (in the engine
 * daemon, no Python), keep a TypeSafe key for the hosted Jev, and try either
 * on a state and a few typed questions. Both answer the same request shape,
 * so what is tried here is what an agent tool or the engine's
 * `/v1/decisions` endpoint gets.
 */
export function DecisionModels() {
  const pushToast = useStore((s) => s.pushToast);
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const [catalog, setCatalog] = useState<DecisionCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledDecisionModel[]>([]);
  const [status, setStatus] = useState<DecisionStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [folder, setFolder] = useState('');

  const refresh = async () => {
    const [c, m, s] = await Promise.all([
      window.nekko.decisionsCatalog().catch(() => []),
      window.nekko.decisionsModels().catch(() => []),
      window.nekko.decisionsStatus().catch(() => null),
    ]);
    setCatalog(c);
    setInstalled(m);
    setStatus(s);
    return m;
  };
  useEffect(() => { void refresh(); }, []);

  const act = async (id: string, run: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(id);
    const res = await run().catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(null);
    pushToast(res.ok ? 'success' : 'error', res.message);
    await refresh();
    return res;
  };

  const saveKey = async () => {
    await window.nekko.updateSettings({ typesafeApiKey: key.trim() || undefined });
    await refreshSettings();
    setKey('');
    await refresh();
    if (key.trim()) await act('typesafe', () => window.nekko.decisionsCheckTypesafe());
  };

  const folders = installed.filter((m) => m.external);
  return (
    <div className="space-y-5">
      <p className="text-[12px] text-ink-faint">
        Decision models answer typed questions about a text or JSON state (pick one option, score on a scale, true or false) with calibrated probabilities, in one pass and without generating text. Agents use them for routing, triage and guardrails. One is loaded at a time.
      </p>

      {catalog.map((entry) => (
        <CatalogCard key={entry.id} entry={entry} have={installed.find((m) => m.id === entry.id)} status={status} busy={busy} act={act} refresh={refresh} />
      ))}

      <div className="rounded-lg border border-line p-3 text-[12px]" data-decision-folders>
        <div className="text-[13px] font-semibold">Your own exports</div>
        <p className="mt-1 text-ink-soft">A folder with an ONNX export of a Laya checkpoint, its tokenizer.json and rl_agent_config.json, read where it is. docs/decision-models.md has the recipe.</p>
        {folders.map((m) => (
          <FolderModel key={m.id} model={m} status={status} busy={busy} act={act} />
        ))}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1 py-1 text-[12px]"
            aria-label="Export folder"
            placeholder="Add an export folder, e.g. C:\models\laya-en-onnx"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <button
            className="btn btn-outline py-1 text-[12px]"
            disabled={!folder.trim() || busy !== null}
            onClick={() => void act('folder', () => window.nekko.decisionsAddFolder(folder)).then((r) => { if (r.ok) setFolder(''); })}
          >
            Add folder
          </button>
        </div>
        {status && !status.local.available && <p className="mt-2 text-ink-faint">{status.local.reason}</p>}
      </div>

      <div className="rounded-lg border border-line p-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">TypeSafe Jev</span>
          <span className="chip">hosted</span>
          {status?.typesafe.configured && <span className="chip" style={{ color: 'var(--success)' }}>key set</span>}
        </div>
        <p className="mt-1 text-ink-soft">TypeSafe's hosted decision model, with the same questions and answers. Requests go to api.typesafe.ai with your key; keys come from console.typesafe.ai.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1 py-1 text-[12px]"
            type="password"
            autoComplete="off"
            aria-label="TypeSafe API key"
            placeholder={settings?.typesafeApiKey ? 'A key is saved. Paste a new one to replace it.' : 'TypeSafe API key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn btn-outline py-1 text-[12px]" disabled={!key.trim()} onClick={() => void saveKey()}>Save key</button>
          {settings?.typesafeApiKey && !key.trim() && (
            <button className="btn btn-ghost py-1 text-[12px] text-ink-faint" onClick={() => void saveKey()}>Remove key</button>
          )}
          {status?.typesafe.configured && (
            <button className="btn btn-ghost py-1 text-[12px]" disabled={busy !== null} onClick={() => void act('typesafe', () => window.nekko.decisionsCheckTypesafe())}>Check key</button>
          )}
        </div>
      </div>

      <DecisionPlayground status={status} />
    </div>
  );
}

/** A state, some questions, and the answers with their probabilities. */
function DecisionPlayground({ status }: { status: DecisionStatus | null }) {
  const [provider, setProvider] = useState<DecisionProvider>('local');
  const [state, setState] = useState(EXAMPLE_STATE);
  const [questions, setQuestions] = useState(EXAMPLE_QUESTIONS);
  const [result, setResult] = useState<DecisionResponse | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const ready = provider === 'local' ? !!status?.local.loaded : !!status?.typesafe.configured;

  const run = async () => {
    setError('');
    let parsed: DecisionRequest['questions'];
    try {
      parsed = JSON.parse(questions);
    } catch (e) {
      setError(`The questions are not valid JSON: ${(e as Error).message}`);
      return;
    }
    let body: DecisionRequest['state'] = state;
    const trimmed = state.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { body = JSON.parse(trimmed); } catch { /* plain text that happens to start with a brace */ }
    }
    setRunning(true);
    try {
      setResult(await window.nekko.decisionsRun(provider, { state: body, questions: parsed }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-lg border border-line p-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">Try it</span>
        <div role="radiogroup" aria-label="Decision provider" className="inline-flex rounded-lg border border-line p-0.5">
          {(['local', 'typesafe'] as const).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={provider === p}
              onClick={() => setProvider(p)}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${provider === p ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink'}`}
            >
              {p === 'local' ? 'Laya (local)' : 'Jev (TypeSafe)'}
            </button>
          ))}
        </div>
      </div>
      <label className="mt-2 block">State<textarea className="input mt-1 min-h-16 w-full text-[12px]" value={state} onChange={(e) => setState(e.target.value)} /></label>
      <label className="mt-2 block">Questions (JSON)<textarea className="input mt-1 min-h-40 w-full font-mono text-[11.5px]" spellCheck={false} value={questions} onChange={(e) => setQuestions(e.target.value)} /></label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-primary py-1 text-[12px]" disabled={running || !ready} onClick={() => void run()}>{running ? 'Deciding…' : 'Decide'}</button>
        {!ready && <span className="text-ink-faint">{provider === 'local' ? 'Load Laya above first.' : 'Save a TypeSafe key above first.'}</span>}
        {result && <span className="text-ink-faint">{result.model} · {result.latencyMs} ms</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-ink-soft">{error}</p>}
      {result && (
        <div className="mt-3 space-y-3">
          {Object.entries(result.answers).map(([id, a]) => <AnswerCard key={id} id={id} answer={a} />)}
        </div>
      )}
    </div>
  );
}

function AnswerCard({ id, answer }: { id: string; answer: DecisionAnswer }) {
  if (answer.error) return <p className="text-ink-soft"><span className="font-mono">{id}</span>: {answer.error}</p>;
  const headline = answer.type === 'noul'
    ? `${Math.round((answer.noul ?? 0) * 100)}% true`
    : answer.type === 'choice'
      ? answer.choice
      : `${answer.score?.toFixed(2)}${answer.legend && answer.score !== undefined ? ` (${answer.legend[String(Math.round(answer.score))] ?? ''})` : ''}`;
  const bars = answer.type === 'noul'
    ? [['true', answer.noul ?? 0], ['false', 1 - (answer.noul ?? 0)]] as const
    : Object.entries(answer.probabilities ?? {}).map(([k, p]) => [answer.legend?.[k] ?? k, p] as const);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11.5px]">{id}</span>
        <span className="chip">{answer.type}</span>
        <span className="font-semibold">{headline}</span>
        {answer.confidence !== undefined && <span className="text-ink-faint">confidence {Math.round(answer.confidence * 100)}%</span>}
      </div>
      <div className="mt-1 space-y-0.5">
        {bars.map(([label, p]) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate text-ink-faint">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full" style={{ width: `${Math.round(p * 100)}%`, background: 'var(--accent)' }} />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-ink-faint">{Math.round(p * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** An export folder the user added: load it, unload it, or forget it (its files stay). */
function FolderModel({ model, status, busy, act }: {
  model: InstalledDecisionModel;
  status: DecisionStatus | null;
  busy: string | null;
  act: (id: string, run: () => Promise<{ ok: boolean; message: string }>) => Promise<{ ok: boolean; message: string }>;
}) {
  const loaded = !!status?.local.loaded && !!status.local.dir && status.local.dir.replace(/[\/]+$/, '').toLowerCase() === model.dir.replace(/[\/]+$/, '').toLowerCase();
  const [precision, setPrecision] = useState<DecisionPrecision>(model.precisions[0]);
  return (
    <div className="mt-2 rounded-md border border-line px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{model.name}</span>
        <span className="min-w-0 truncate text-ink-faint" title={model.dir}>{model.dir}</span>
        {loaded && <span className="chip" style={{ color: 'var(--success)' }}>loaded</span>}
      </div>
      {loaded && status?.local.ep && (
        <p className="mt-0.5 text-ink-faint">
          Running {status.local.precision} on {status.local.ep}{status.local.loadMs ? `, loaded in ${(status.local.loadMs / 1000).toFixed(1)} s` : ''}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1 text-[12px]" aria-label="Precision" value={precision} onChange={(e) => setPrecision(e.target.value as DecisionPrecision)} disabled={loaded}>
          {model.precisions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {status?.local.available && !loaded && (
          <button className="btn btn-primary py-1 text-[12px]" disabled={busy !== null} onClick={() => void act(model.id, () => window.nekko.decisionsLoad(model.id, precision))}>
            {busy === model.id ? 'Loading…' : 'Load'}
          </button>
        )}
        {loaded && <button className="btn btn-outline py-1 text-[12px]" disabled={busy !== null} onClick={() => void act(model.id, () => window.nekko.decisionsUnload())}>Unload</button>}
        <button className="btn btn-ghost py-1 text-[12px] text-ink-faint" disabled={busy !== null} onClick={() => void act(model.id, () => window.nekko.decisionsDelete(model.id))}>Remove from list</button>
      </div>
    </div>
  );
}

/** One catalog model: its precisions, the download, and loading what is on disk. */
export function CatalogCard({ entry, have, status, busy, act, refresh }: {
  entry: DecisionCatalogEntry;
  have?: InstalledDecisionModel;
  status: DecisionStatus | null;
  busy: string | null;
  act: (id: string, run: () => Promise<{ ok: boolean; message: string }>) => Promise<{ ok: boolean; message: string }>;
  refresh: () => Promise<InstalledDecisionModel[]>;
}) {
  const recommended = entry.variants.find((v) => v.recommended) ?? entry.variants[0];
  const [precision, setPrecision] = useState<DecisionPrecision>(recommended.precision);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => {
      void refresh().then((m) => { if (m.some((x) => x.id === entry.id && x.precisions.includes(precision))) setDownloading(false); });
    }, 3000);
    return () => clearInterval(t);
  }, [downloading, precision, entry.id]);
  const loaded = status?.local.loaded && status.local.model === entry.id;
  const variant = entry.variants.find((v) => v.precision === precision) ?? recommended;
  const bytes = variant.bytes + entry.shared.reduce((n, f) => n + f.bytes, 0);
  return (
    <div className="rounded-lg border border-line p-3 text-[12px]" data-decision-model={entry.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">{entry.name}</span>
        <span className="chip">{entry.license}</span>
        <span className="text-ink-faint">{entry.publisher}{entry.source ? ` · ${entry.source}` : ''}</span>
        {loaded && <span className="chip" style={{ color: 'var(--success)' }}>loaded</span>}
      </div>
      <p className="mt-1 text-ink-soft">{entry.description}</p>
      {have && (
        <p className="mt-1 text-ink-faint">
          On disk: {have.precisions.join(', ')} · {formatBytes(have.sizeBytes)}
          {loaded && status?.local.ep && ` · running ${status.local.precision} on ${status.local.ep}${status.local.loadMs ? `, loaded in ${(status.local.loadMs / 1000).toFixed(1)} s` : ''}`}
        </p>
      )}
      {(!entry.unavailable || have) && <div className="mt-2 flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1 text-[12px]" aria-label={`${entry.name} precision`} value={precision} onChange={(e) => setPrecision(e.target.value as DecisionPrecision)}>
          {entry.variants.map((v) => (
            <option key={v.precision} value={v.precision}>{v.precision}{v.recommended ? ' (recommended)' : ''} · {formatBytes(v.bytes)}</option>
          ))}
        </select>
        {!entry.unavailable && !have?.precisions.includes(precision) && (
          <button
            className="btn btn-outline py-1 text-[12px]"
            disabled={busy !== null || downloading}
            onClick={() => void act(entry.id, () => window.nekko.decisionsDownload(entry.id, precision)).then((r) => { if (r.ok) setDownloading(true); })}
          >
            {downloading ? 'Downloading…' : `Download ${formatBytes(bytes)}`}
          </button>
        )}
        {have?.precisions.includes(precision) && status?.local.available && !loaded && (
          <button className="btn btn-primary py-1 text-[12px]" disabled={busy !== null} onClick={() => void act(entry.id, () => window.nekko.decisionsLoad(entry.id, precision))}>
            {busy === entry.id ? 'Loading…' : 'Load'}
          </button>
        )}
        {loaded && (
          <button className="btn btn-outline py-1 text-[12px]" disabled={busy !== null} onClick={() => void act(entry.id, () => window.nekko.decisionsUnload())}>Unload</button>
        )}
        {have && (
          <button
            className="btn btn-ghost py-1 text-[12px] text-ink-faint"
            disabled={busy !== null}
            onClick={() => { if (window.confirm(`Delete ${entry.name} from disk?`)) void act(entry.id, () => window.nekko.decisionsDelete(entry.id)); }}
          >
            Delete
          </button>
        )}
      </div>}
      {entry.unavailable && !have && <p className="mt-2 text-ink-faint">{entry.unavailable}</p>}
    </div>
  );
}
