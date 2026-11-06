import React, { useEffect, useRef, useState } from 'react';
import {
  FEEDBACK_CONTRIBUTING_URL, FEEDBACK_ISSUES_URL, FEEDBACK_MAX_CHARS, FEEDBACK_SUMMARY_MAX_CHARS,
  agentPrompt, appInfoLine, feedbackNote, feedbackNoteLength, type FeedbackAppInfo, type FeedbackKind,
} from '@nekko-agent/shared';
import { CheckIcon, CloseIcon, WrenchIcon } from '../icons.js';
import { FeedbackScreenshots, useFeedbackScreenshots } from './FeedbackScreenshots.js';
import { StarryNekko } from './StarryNekko.js';
import { Modal, Toggle } from './primitives/index.js';

/** Opens the sheet from anywhere: the rail button, the command palette, Help → Send feedback…. */
export const openFeedback = () => window.dispatchEvent(new Event('nekko:feedback'));

const PROMPTS: Record<FeedbackKind, { summary: string; description: string; sent: string }> = {
  good: {
    summary: "What's working well?",
    description: 'What did you like, and what were you doing at the time?',
    sent: 'The team appreciates your feedback and will continue on more awesome stuff!',
  },
  improve: {
    summary: 'What needs work?',
    description: 'What could be better, and what would you like to see?',
    sent: 'Thanks for telling us. The team will take a look at what we can improve!',
  },
};

/**
 * "Send feedback" (#1004, #1725): one form for a note to Nekko Labs, with a
 * person's own agent or the GitHub issue forms as the other ways in. A modal
 * over whatever view is showing, like About, so it needs no route of its own.
 */
export function FeedbackSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('nekko:feedback', show);
    return () => window.removeEventListener('nekko:feedback', show);
  }, []);
  if (!open) return null;
  return <FeedbackBody onClose={() => setOpen(false)} />;
}

function ExternalLink({ url, className, testId, children }: { url: string; className?: string; testId?: string; children: React.ReactNode }) {
  return (
    <a href={url} className={className} data-testid={testId} onClick={e => { e.preventDefault(); window.nekko.openPath(url).catch(() => {}); }}>
      {children}
    </a>
  );
}

function ContributeNote() {
  return (
    <p className="text-2xs text-ink-faint">
      Interested in contributing? Nekko Agent is open source. <ExternalLink url={FEEDBACK_CONTRIBUTING_URL} className="text-accent underline underline-offset-2">Read the contributing guide</ExternalLink>.
    </p>
  );
}

function KindTile({ value, chosen, onChoose, inputRef, icon, title, hint }: {
  value: FeedbackKind;
  chosen: boolean;
  onChoose: (kind: FeedbackKind) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <label className={`relative flex cursor-pointer items-center gap-2 rounded-xl border py-2 pl-3 pr-8 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${chosen ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
      <input ref={inputRef} className="sr-only" type="radio" name="feedback-kind" value={value} checked={chosen} onChange={() => onChoose(value)} data-testid={`feedback-kind-${value}`} />
      {icon}
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{title}</span>
        <span className="block text-2xs text-ink-faint">{hint}</span>
      </span>
      {chosen && <span className="absolute right-3 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded-full bg-accent text-on-accent"><CheckIcon className="h-3 w-3" /></span>}
    </label>
  );
}

export function FeedbackBody({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<FeedbackAppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [includeInfo, setIncludeInfo] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<FeedbackKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const screenshots = useFeedbackScreenshots();

  const firstChoice = useRef<HTMLInputElement>(null);
  const summaryField = useRef<HTMLInputElement>(null);
  const descriptionField = useRef<HTMLTextAreaElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    window.nekko.feedbackInfo().then(i => { if (live) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // The control that had focus is gone from these two views, so hand it on.
  useEffect(() => { if (sent) closeButton.current?.focus(); }, [sent]);
  useEffect(() => { if (discarding) keepEditing.current?.focus(); }, [discarding]);

  const prompt = agentPrompt(info);
  const copy = () => {
    navigator.clipboard?.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {});
  };

  const length = kind ? feedbackNoteLength(kind, summary, description) : 0;
  const over = length - FEEDBACK_MAX_CHARS;
  const summaryProblem = summary.trim() ? null : 'Add a short summary.';
  const descriptionProblem = !description.trim() ? 'Add a description.' : over > 0 ? `Shorten this by ${over.toLocaleString('en-US')} characters.` : null;
  const blocked = !!summaryProblem || !!descriptionProblem;
  const showSummaryProblem = attempted && summaryProblem;
  const showDescriptionProblem = (attempted || over > 0) && descriptionProblem;

  const send = async () => {
    if (!kind || sending) return;
    if (blocked) {
      setAttempted(true);
      (summaryProblem ? summaryField : descriptionField).current?.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Only Needs improvement offers app info and screenshots; anything set before changing to Good stays behind.
      const improving = kind === 'improve';
      await window.nekko.feedbackSend(feedbackNote(kind, summary, description), improving && includeInfo, improving ? await screenshots.forUpload() : []);
      setDiscarding(false);
      setSent(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setSending(false);
    }
  };

  // Escape, the X and the scrim all come through here, so none of them can lose a draft.
  const requestClose = () => {
    if (discarding) {
      setDiscarding(false);
      requestAnimationFrame(() => sendButton.current?.focus());
    } else if (!sent && (summary.trim() || description.trim() || screenshots.shots.length)) {
      setDiscarding(true);
    } else {
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      void send();
    } else if (target === summaryField.current) {
      // One line in, so Enter moves on rather than sending half a form.
      e.preventDefault();
      descriptionField.current?.focus();
    } else if (target instanceof HTMLInputElement && target.type === 'radio') {
      e.preventDefault();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (kind !== 'improve' || !files.length) return;
    e.preventDefault();
    void screenshots.add(files);
  };

  const onDrop = (e: React.DragEvent) => {
    if (kind !== 'improve') return;
    e.preventDefault();
    void screenshots.add([...e.dataTransfer.files]);
  };

  const status = sent ? `Your feedback was sent successfully. ${PROMPTS[sent].sent}`
    : sending ? 'Sending your feedback.'
      : over > 0 ? `Over the ${FEEDBACK_MAX_CHARS.toLocaleString('en-US')} character limit.`
        : length >= FEEDBACK_MAX_CHARS * 0.9 ? `Close to the ${FEEDBACK_MAX_CHARS.toLocaleString('en-US')} character limit.`
          : kind ? 'Summary and description added below.' : '';

  return (
    <Modal
      title="Send feedback"
      onClose={requestClose}
      initialFocus={firstChoice}
      align="top"
      overlayClassName="px-4 pb-4 pt-[6vh]!"
      zIndex={100}
      className="card flex max-h-full w-[576px] max-w-full flex-col shadow-(--shadow-float)"
    >
      <div className="flex min-h-0 flex-col" data-testid="feedback-sheet">
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink">Send feedback</h2>
            {!sent && <p className="mt-0.5 text-xs text-ink-faint">Tell Nekko Labs what's working and what could be better. It's sent without your name or account, so we can't reply.</p>}
          </div>
          <button ref={closeButton} type="button" className="btn btn-ghost px-2! py-1!" aria-label="Close" onClick={requestClose}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {sent ? (
          <div className="px-5 pb-5 pt-1" data-testid="feedback-sent">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              Your feedback was sent successfully
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><CheckIcon className="h-4 w-4" /></span>
            </h3>
            <p className="mt-1 text-xs text-ink-soft">{PROMPTS[sent].sent}</p>
            <div className="mt-3"><ContributeNote /></div>
          </div>
        ) : (
          <form className="flex min-h-0 flex-col" noValidate onKeyDown={onKeyDown} onPaste={onPaste} onDragOver={e => { if (kind === 'improve') e.preventDefault(); }} onDrop={onDrop} onSubmit={e => { e.preventDefault(); void send(); }}>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-1">
              <fieldset>
                <legend className="mb-1 block text-xs font-medium text-ink-soft">What kind of feedback is this?</legend>
                <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                  <KindTile value="good" chosen={kind === 'good'} onChoose={setKind} inputRef={firstChoice} icon={<StarryNekko />} title="Good" hint="Something's working well" />
                  <KindTile value="improve" chosen={kind === 'improve'} onChoose={setKind} icon={<WrenchIcon className="h-5 w-5 shrink-0 text-ink-soft" />} title="Needs improvement" hint="Something needs work" />
                </div>
              </fieldset>

              {kind && (
                <div className="flex flex-col gap-4 fade-in" data-testid="feedback-fields">
                  <div>
                    <label htmlFor="feedback-summary" className="mb-1 block text-xs font-medium text-ink-soft">Summary</label>
                    <div className={`relative rounded-xl border transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)] ${showSummaryProblem ? 'border-danger' : 'border-line'}`}>
                      <input
                        ref={summaryField}
                        id="feedback-summary"
                        className="w-full bg-transparent py-2 pl-3 pr-16 text-sm text-ink outline-hidden placeholder:text-ink-faint"
                        placeholder={PROMPTS[kind].summary}
                        value={summary}
                        maxLength={FEEDBACK_SUMMARY_MAX_CHARS}
                        autoComplete="off"
                        aria-required="true"
                        aria-invalid={!!showSummaryProblem}
                        aria-describedby="feedback-summary-count feedback-summary-error"
                        onChange={e => setSummary(e.target.value)}
                        data-testid="feedback-summary"
                      />
                      <span id="feedback-summary-count" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-2xs tabular-nums text-ink-faint">{[...summary.trim()].length} / {FEEDBACK_SUMMARY_MAX_CHARS}</span>
                    </div>
                    {showSummaryProblem && <p id="feedback-summary-error" className="mt-1 text-xs text-danger">{summaryProblem}</p>}
                  </div>

                  <div>
                    <label htmlFor="feedback-description" className="mb-1 block text-xs font-medium text-ink-soft">Description</label>
                    <div className={`rounded-xl border transition-colors focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)] ${showDescriptionProblem ? 'border-danger' : 'border-line'}`}>
                      <textarea
                        ref={descriptionField}
                        id="feedback-description"
                        className="block min-h-28 w-full resize-y bg-transparent px-3 pb-1 pt-2 text-sm text-ink outline-hidden placeholder:text-ink-faint"
                        placeholder={PROMPTS[kind].description}
                        value={description}
                        maxLength={FEEDBACK_MAX_CHARS * 2}
                        aria-required="true"
                        aria-invalid={!!showDescriptionProblem}
                        aria-describedby="feedback-description-count feedback-description-error"
                        onChange={e => setDescription(e.target.value)}
                        data-testid="feedback-text"
                      />
                      <p id="feedback-description-count" className={`px-3 pb-2 text-right text-2xs tabular-nums ${over > 0 ? 'font-medium text-danger' : 'text-ink-faint'}`} onClick={() => descriptionField.current?.focus()}>
                        {length.toLocaleString('en-US')} / {FEEDBACK_MAX_CHARS.toLocaleString('en-US')} characters
                      </p>
                    </div>
                    {showDescriptionProblem && <p id="feedback-description-error" className="mt-1 text-xs text-danger">{descriptionProblem}</p>}
                  </div>

                  {kind === 'improve' && <FeedbackScreenshots {...screenshots} />}

                  {kind === 'improve' && (
                    <label className="flex items-start gap-2">
                      <Toggle value={includeInfo} onChange={setIncludeInfo} label="Include app info" />
                      <span className="text-xs">
                        <span className="text-ink">Include app info</span>
                        <span className="block text-2xs text-ink-faint">
                          App, version, OS and version, and CPU type. Nothing that identifies you.
                          {includeInfo && info && <span className="mt-0.5 block font-mono text-ink-soft">{appInfoLine(info).replace(/^App: /, '')}</span>}
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              )}

              <details className="rounded-xl border border-line px-3 py-2 text-xs text-ink-soft">
                <summary className="cursor-pointer font-medium text-ink-faint">Other ways: use an agent, or create a GitHub issue yourself</summary>
                <div className="mt-2 grid gap-2">
                  <section className="rounded-xl border border-line px-3 py-2" aria-labelledby="feedback-agent">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 id="feedback-agent" className="font-medium text-ink">Let an agent help you write it</h3>
                        <p className="text-2xs text-ink-faint">Copy a prompt into Claude Code, Codex or a Nekko agent. It asks you a few questions, then files a GitHub issue once you approve it.</p>
                      </div>
                      <button type="button" className="btn btn-outline shrink-0 px-2! py-1! text-xs" onClick={copy} data-testid="feedback-copy">{copied ? 'Copied' : 'Copy prompt'}</button>
                    </div>
                    <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-line px-2 py-1 font-mono text-2xs text-ink-faint" aria-label="Prompt that will be copied">{prompt}</pre>
                  </section>
                  <section className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2" aria-labelledby="feedback-github">
                    <div>
                      <h3 id="feedback-github" className="font-medium text-ink">Create a GitHub issue yourself</h3>
                      <p className="text-2xs text-ink-faint">No agent needed. Fill in the form on GitHub. Issues are public, so you can follow along and get replies.</p>
                    </div>
                    <ExternalLink url={FEEDBACK_ISSUES_URL} className="btn btn-outline shrink-0 px-2! py-1! text-xs" testId="feedback-github">Create issue</ExternalLink>
                  </section>
                </div>
              </details>
            </div>

            <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
              {error && <p className="rounded-xl border border-danger px-3 py-2 text-xs text-ink" style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }} role="alert">{error} Your feedback is still here.</p>}
              {discarding ? (
                <div className="flex items-center gap-3 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }} data-testid="feedback-discard">
                  <span className="min-w-0 flex-1"><strong className="font-semibold">Discard this feedback?</strong> What you've written and added will be lost.</span>
                  <button ref={keepEditing} type="button" className="btn btn-outline shrink-0 px-2! py-1! text-xs" onClick={requestClose}>Keep editing</button>
                  <button type="button" className="btn btn-ghost shrink-0 px-2! py-1! text-xs" onClick={onClose}>Discard</button>
                </div>
              ) : kind && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {!attempted && over <= 0 && blocked && <span className="mr-auto text-xs text-ink-faint">{summaryProblem ?? descriptionProblem}</span>}
                  <button
                    ref={sendButton}
                    type="submit"
                    className={`btn btn-primary ${blocked || sending ? 'cursor-not-allowed opacity-55' : ''}`}
                    aria-disabled={blocked || sending}
                    aria-keyshortcuts="Control+Enter Meta+Enter"
                    data-testid="feedback-send"
                  >
                    {sending ? 'Sending…' : 'Send feedback'}
                  </button>
                </div>
              )}
              <ContributeNote />
            </div>
          </form>
        )}
        <div className="sr-only" role="status">{status}</div>
      </div>
    </Modal>
  );
}
