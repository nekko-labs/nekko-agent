import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskAnswer, AskQuestion, AskRequest } from '@nekko-agent/shared';
import { PixelQuestionIcon } from './PixelQuestionIcon.js';
import { ASK_OTHER_LABEL, isAskComplete } from '@nekko-agent/shared';

/**
 * The agent's question, asked one at a time.
 *
 * Four questions on one card is a form, and people read forms by skimming them
 * and answering the first one properly. So this walks: one question fills the
 * card, you pick, you hit Next, the next one takes its place. The step you are
 * on is the only thing to think about, and the dots above say how much is left
 * so it never feels open-ended.
 *
 * Options are a vertical list, full width, never wrapping into a second column.
 * A wrapped grid makes the eye jump and hides the long option behind an
 * ellipsis; a list is read top to bottom at a glance, has room for the
 * one-line description that makes the choice meaningful, and answers to arrow
 * keys and number keys the way a list should.
 *
 * "You decide" is a real answer, not a dismissal. It resolves the call with
 * nothing, which tells the agent to choose for itself and say so — an agent
 * left waiting on a question the user closed is a run that never finishes.
 */
export function QuestionCard({
  request,
  onAnswer,
  onSkip,
  compact = false,
  tone = 'attention',
}: {
  request: AskRequest;
  onAnswer: (answers: AskAnswer[]) => void;
  onSkip: () => void;
  /** Board cards are narrower and sit among other cards, so they sit tighter. */
  compact?: boolean;
  /**
   * Unanswered questions default to the orange attention highlight.
   * An explicit accent tone is available for branded surfaces.
   */
  tone?: 'accent' | 'attention';
}) {
  const hue = tone === 'attention' ? 'var(--warning)' : 'var(--accent)';
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  /** Which row the keyboard is on. Follows the mouse so the two never disagree. */
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // Mirrors of the two answer stores, written by the same handlers that set
  // them so they are current *within* an event rather than one render behind.
  // A pick and a send can land in the same keystroke; see `goNext`.
  const pickedRef = useRef(picked);
  const notesRef = useRef(notes);

  const total = request.questions.length;
  const index = Math.min(step, total - 1);
  const q = request.questions[index] as AskQuestion;
  const last = index === total - 1;

  const answers = useMemo<AskAnswer[]>(
    () => toAnswers(request.questions, picked, notes),
    [request.questions, picked, notes],
  );
  const complete = isAskComplete(request, answers);
  const answered = useMemo(() => {
    const done = new Set<string>();
    for (const a of answers) done.add(a.questionId);
    return done;
  }, [answers]);

  const chosen = picked[q.id] ?? [];
  const note = notes[q.id] ?? '';
  const otherShown = !!otherOpen[q.id] || !!note;
  const hasAnswer = chosen.length > 0 || !!note.trim();
  /** The option rows plus the "Something else" row the keyboard also walks. */
  const rowCount = q.options.length + 1;

  // A new question starts at the top, and the card takes the keyboard so the
  // whole thing is answerable without reaching for the mouse. Board cards sit
  // among other cards and don't get to steal focus.
  useEffect(() => {
    setCursor(0);
    if (!compact) rootRef.current?.focus({ preventScroll: true });
  }, [index, compact]);

  const toggle = useCallback(
    (label: string) => {
      const current = pickedRef.current[q.id] ?? [];
      const next = { ...pickedRef.current, [q.id]: togglePick(current, label, !!q.multiSelect) };
      pickedRef.current = next;
      setPicked(next);
    },
    [q.id, q.multiSelect],
  );

  const setNote = useCallback(
    (value: string) => {
      const next = { ...notesRef.current, [q.id]: value };
      notesRef.current = next;
      setNotes(next);
    },
    [q.id],
  );

  /**
   * Advance, or send if this was the last question.
   *
   * Sending reads the picks off refs rather than off the render that fired it,
   * because Enter on the final question both chooses and sends: the `answers`
   * this closure captured predates that choice by one render, so sending it
   * would drop the very option the user just hit Enter on. The refs are written
   * by the same setters, so they are current within the event.
   */
  const goNext = useCallback(() => {
    if (!last) {
      setStep(index + 1);
      return;
    }
    onAnswer(toAnswers(request.questions, pickedRef.current, notesRef.current));
  }, [index, last, onAnswer, request.questions]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      // Typing an answer: Enter commits it, everything else is text.
      if (e.key === 'Enter') {
        e.preventDefault();
        goNext();
      }
      return;
    }
    // A tabbed-to button already turns Enter and Space into its own click;
    // handling them again here would toggle the pick twice.
    const onButton = target?.tagName === 'BUTTON';
    if (onButton && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((c) => (c + delta + rowCount) % rowCount);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < q.options.length) {
        e.preventDefault();
        setCursor(i);
        toggle(q.options[i]!.label);
      }
      return;
    }
    if (e.key === ' ' && cursor < q.options.length) {
      e.preventDefault();
      toggle(q.options[cursor]!.label);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (cursor >= q.options.length) {
        setOtherOpen((p) => ({ ...p, [q.id]: true }));
        return;
      }
      // One pick answers a single-choice question outright, so Enter can both
      // choose and move on. Multi-select needs Enter to mean "done picking".
      if (!q.multiSelect && !chosen.includes(q.options[cursor]!.label)) toggle(q.options[cursor]!.label);
      goNext();
      return;
    }
    if (e.key === 'Backspace' && index > 0) {
      e.preventDefault();
      setStep(index - 1);
    }
  };

  return (
    <div
      ref={rootRef}
      className="rounded-xl border p-3 outline-hidden"
      data-question-tone={tone}
      style={{
        ...(tone === 'attention' ? { '--accent': 'var(--warning)', '--brand-grad': 'var(--warning)', '--on-accent': '#201609' } : {}),
        borderColor: `color-mix(in srgb, ${hue} 70%, transparent)`,
        borderWidth: 1.5,
        background: `color-mix(in srgb, ${hue} 8%, var(--surface-2))`,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${hue} 14%, transparent)`,
      } as React.CSSProperties}
      role="group"
      aria-label="The agent is asking a question"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="mb-2 flex items-center gap-2">
        <PixelQuestionIcon className="h-4 w-4 shrink-0" />
        <span className="text-2xs font-semibold uppercase tracking-wide" style={{ color: hue }}>
          Before I start
        </span>
        {total > 1 && (
          <>
            <span className="ml-auto flex items-center gap-1">
              {request.questions.map((item, i) => {
                const done = answered.has(item.id);
                const here = i === index;
                return (
                  <button
                    key={item.id}
                    className="h-1.5 rounded-full transition-all"
                    style={{
                      width: here ? 14 : 6,
                      background: here
                        ? 'var(--accent)'
                        : done
                          ? 'color-mix(in srgb, var(--accent) 55%, transparent)'
                          : 'var(--line)',
                    }}
                    title={item.header}
                    aria-label={`Question ${i + 1}: ${item.question}`}
                    aria-current={here ? 'step' : undefined}
                    onClick={() => setStep(i)}
                  />
                );
              })}
            </span>
            <span className="text-2xs text-ink-soft">
              {index + 1} of {total}
            </span>
          </>
        )}
        {total === 1 && <span className="ml-auto text-2xs text-ink-soft">1 question</span>}
      </div>

      {/* Keyed on the question so each step animates in as its own thing rather
          than the text swapping underneath the same box. */}
      <div key={q.id} className="fade-in">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="chip shrink-0 text-2xs uppercase tracking-wide">{q.header}</span>
          <span className={`${compact ? 'text-xs' : tone === 'attention' ? 'text-sm font-semibold' : 'text-xs'} font-medium text-ink`}>{q.question}</span>
          <span className="text-2xs text-ink-soft">{q.multiSelect ? 'pick any' : 'pick one'}</span>
        </div>

        <div
          className="flex flex-col gap-1"
          role={q.multiSelect ? 'group' : 'radiogroup'}
          aria-label={q.question}
        >
          {q.options.map((o, i) => {
            const on = chosen.includes(o.label);
            const here = cursor === i;
            return (
              <button
                key={o.label}
                className="flex w-full items-start gap-2 rounded-lg border px-3 py-1 text-left transition-colors"
                style={{
                  borderColor: on ? 'var(--accent)' : here ? 'color-mix(in srgb, var(--accent) 40%, var(--line))' : 'var(--line)',
                  background: on
                    ? 'color-mix(in srgb, var(--accent) 18%, var(--surface-2))'
                    : here
                      ? 'color-mix(in srgb, white 8%, var(--surface-2))'
                      : 'color-mix(in srgb, white 4%, var(--surface-2))',
                }}
                role={q.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  setCursor(i);
                  toggle(o.label);
                }}
              >
                <Marker on={on} multi={!!q.multiSelect} />
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-xs font-medium"
                    style={{ color: on ? 'var(--accent)' : 'var(--ink)' }}
                  >
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="mt-0.5 block text-2xs leading-snug text-ink-soft">{o.description}</span>
                  )}
                </span>
                {!compact && <span className="mt-0.5 shrink-0 text-2xs text-ink-soft">{i + 1}</span>}
              </button>
            );
          })}

          {!otherShown ? (
            <button
              className="flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-1 text-left text-xs text-ink-soft transition-colors hover:text-ink"
              style={{
                borderColor: cursor >= q.options.length ? 'color-mix(in srgb, var(--accent) 40%, var(--line))' : 'var(--line)',
                background: cursor >= q.options.length ? 'color-mix(in srgb, white 8%, var(--surface-2))' : 'color-mix(in srgb, white 4%, var(--surface-2))',
              }}
              onMouseEnter={() => setCursor(q.options.length)}
              onClick={() => setOtherOpen((p) => ({ ...p, [q.id]: true }))}
            >
              <Marker on={false} multi={!!q.multiSelect} />
              {ASK_OTHER_LABEL}
            </button>
          ) : (
            <input
              className="input mt-0.5 py-1 text-xs"
              autoFocus
              placeholder={`${ASK_OTHER_LABEL} — type it here`}
              aria-label={ASK_OTHER_LABEL}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {index > 0 && (
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setStep(index - 1)}>
            Back
          </button>
        )}
        <button
          className={`btn px-3 py-1 text-xs ${hasAnswer ? 'btn-primary' : 'btn-outline'}`}
          onClick={goNext}
          title={
            last && !complete ? 'Anything left blank goes back as unanswered' : undefined
          }
        >
          {last ? `Send answer${total > 1 || !complete ? 's' : ''}` : hasAnswer ? 'Next' : 'Skip'}
        </button>
        {!compact && (
          <span className="ml-1 truncate text-2xs text-ink-soft">
            ↑↓ or 1–{q.options.length} to pick, ↵ for {last ? 'send' : 'next'}
          </span>
        )}
        <button
          className="btn btn-ghost ml-auto shrink-0 px-2 py-1 text-xs"
          onClick={onSkip}
          title="Let the agent choose and say which it chose"
        >
          You decide
        </button>
      </div>
    </div>
  );
}

/**
 * One option turned on or off, against the response type.
 *
 * Checkboxes accumulate; radios replace, and re-picking the option already on
 * clears it, so a single-select question can be put back to unanswered without
 * a "none of these" option nobody wrote.
 */
export function togglePick(current: readonly string[], label: string, multi: boolean): string[] {
  if (!multi) return current.includes(label) ? [] : [label];
  return current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
}

/**
 * The two answer stores read back as the answers the agent gets.
 *
 * A question with neither a pick nor typed text is left out entirely rather
 * than sent as an empty answer, because `formatAskAnswers` reports a missing
 * entry as "(not answered)" and an empty one would read the same while making
 * `isAskComplete` say the card was finished.
 */
export function toAnswers(
  questions: readonly AskQuestion[],
  picked: Record<string, string[]>,
  notes: Record<string, string>,
): AskAnswer[] {
  return questions
    .map((item) => ({
      questionId: item.id,
      labels: picked[item.id] ?? [],
      note: notes[item.id]?.trim() || undefined,
    }))
    .filter((a) => a.labels.length > 0 || !!a.note);
}

/** The radio dot or checkbox tick, so the shape says whether picks are exclusive. */
function Marker({ on, multi }: { on: boolean; multi: boolean }) {
  return (
    <span
      className={`mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center border ${multi ? 'rounded-[4px]' : 'rounded-full'}`}
      style={{
        borderColor: on ? 'var(--accent)' : 'var(--ink-faint)',
        background: on ? 'var(--accent)' : 'transparent',
      }}
      aria-hidden
    >
      {on &&
        (multi ? (
          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#fff' }} />
        ))}
    </span>
  );
}
