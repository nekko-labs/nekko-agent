import React, { useState } from 'react';
import type { AskAnswer, AskRequest } from '@nekko-agent/shared';

const HEADERS = ['Length', 'Audio', 'Resolution'] as const;

/** The first option of each question: the daemon puts the suggested one first. */
export function suggestedPicks(request: AskRequest): Record<string, string> {
  return Object.fromEntries(request.questions.map((q) => [q.id, q.options[0]?.label ?? '']));
}

/** The total for these picks, from the request's price table; `null` when unpriced. */
export function clipTotal(request: AskRequest, picks: Record<string, string>): number | null {
  const label = (header: string) => {
    const q = request.questions.find((x) => x.header === header);
    return q ? picks[q.id] ?? '' : '';
  };
  const price = request.clip?.prices[HEADERS.map(label).join('|')];
  return typeof price === 'number' ? price : null;
}

/** The answers the daemon reads, with the confirmed total. */
export function clipAnswers(request: AskRequest, picks: Record<string, string>, total: number): AskAnswer[] {
  return [
    ...request.questions.map((q) => ({ questionId: q.id, labels: [picks[q.id]!] })),
    { questionId: 'total', labels: [total.toFixed(2)] },
  ];
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * A paid cloud clip's choice and confirmation in one card (#2973): length,
 * audio and resolution side by side, the total updating with each pick, and
 * the button that starts (and pays for) the clip naming that total.
 */
export function ClipPicker({ request, onAnswer, onSkip }: {
  request: AskRequest;
  onAnswer: (answers: AskAnswer[]) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}) {
  const [picks, setPicks] = useState(() => suggestedPicks(request));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const clip = request.clip!;
  const total = clipTotal(request, picks);
  const send = async () => {
    if (total == null) return;
    setSending(true); setError('');
    try { await onAnswer(clipAnswers(request, picks, total)); }
    catch (e) { setError(String(e)); setSending(false); }
  };
  return <div className="question-card rounded-xl border p-3" data-clip-picker role="group" aria-label={`Make a clip with ${clip.model}`}
    style={{ borderColor: 'color-mix(in srgb, var(--accent) 60%, transparent)', background: 'color-mix(in srgb, var(--accent) 6%, var(--surface-2))' }}>
    <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
      <span className="text-sm font-medium text-ink">Make a clip with {clip.model}</span>
      <span className="text-2xs text-ink-soft">through {clip.via} · paid from your {clip.via} account</span>
    </div>
    <div className="flex flex-col gap-2">
      {request.questions.map((q) => (
        <div key={q.id} className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={q.header}>
          <span className="w-20 shrink-0 text-xs text-ink-soft">{q.header}</span>
          {q.options.map((o) => {
            const on = picks[q.id] === o.label;
            return <button key={o.label} type="button" role="radio" aria-checked={on} disabled={sending}
              data-clip-option={o.label}
              className={`rounded-lg border px-2 py-1 text-xs transition-colors ${on ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-soft hover:bg-surface-2'}`}
              onClick={() => setPicks((p) => ({ ...p, [q.id]: o.label }))}>{o.label}</button>;
          })}
        </div>
      ))}
    </div>
    <div className="mt-3 flex items-baseline justify-between gap-2" data-clip-total>
      <span className="text-xs text-ink-soft">Total</span>
      <strong className="text-base tabular-nums text-ink" aria-live="polite">{total == null ? 'Not priced' : usd(total)}</strong>
    </div>
    <p className="mt-1 text-2xs text-ink-soft">
      Once started it cannot be stopped, and it is charged even if you stop the chat. {clip.sendsPicture ? 'The prompt and the first picture leave' : 'The prompt leaves'} this computer for {clip.via} and the model's provider.
    </p>
    {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
    <div className="mt-3 flex items-center justify-end gap-2">
      <button type="button" className="btn btn-ghost px-3 py-1 text-xs" disabled={sending} onClick={() => void onSkip()}>Cancel</button>
      <button type="button" data-clip-make className="btn btn-primary px-3 py-1 text-xs disabled:opacity-40" disabled={sending || total == null} onClick={() => void send()}>
        {sending ? 'Starting…' : total == null ? 'Make clip' : `Make clip · ${usd(total)}`}
      </button>
    </div>
  </div>;
}
