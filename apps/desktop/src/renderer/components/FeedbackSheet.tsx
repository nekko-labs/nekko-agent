import React, { useEffect, useState } from 'react';
import { FEEDBACK_ISSUES_URL, FEEDBACK_MAX_CHARS, agentPrompt, appInfoLine, type FeedbackAppInfo } from '@nekko-agent/shared';
import { Modal, Toggle } from './primitives/index.js';

/** Opens the sheet from anywhere: the rail button, the command palette, Help → Send feedback…. */
export const openFeedback = () => window.dispatchEvent(new Event('nekko:feedback'));

type Sent = 'idle' | 'sending' | 'sent';

/**
 * "Send feedback" (#1004): copy a prompt for the person's own agent, send a
 * quick note to Nekko Labs, or open the GitHub issue forms. A modal over
 * whatever view is showing, like About, so it needs no route of its own.
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

export function FeedbackBody({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<FeedbackAppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const [includeInfo, setIncludeInfo] = useState(false);
  const [sent, setSent] = useState<Sent>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.nekko.feedbackInfo().then(i => { if (live) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const prompt = agentPrompt(info);
  const copy = () => {
    navigator.clipboard?.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {});
  };
  const length = [...note.trim()].length;
  const send = async () => {
    setSent('sending');
    setError(null);
    try {
      await window.nekko.feedbackSend(note, includeInfo);
      setSent('sent');
      setNote('');
    } catch (e) {
      setSent('idle');
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  return (
    <Modal title="Send feedback" onClose={onClose} overlayClassName="p-4" zIndex={100} className="card feedback-sheet w-[520px] max-w-[94vw] max-h-[90vh] overflow-y-auto shadow-(--shadow-float)">
      <div className="flex flex-col gap-4 p-5" data-testid="feedback-sheet">
        <div>
          <h2 className="text-base font-semibold text-ink">Send feedback</h2>
          <p className="text-xs text-ink-soft">Tell Nekko Labs what's broken or what you'd like. Pick whichever way is easiest.</p>
        </div>

        <section className="flex flex-col gap-2 rounded-lg border border-line p-3" aria-labelledby="feedback-agent">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="feedback-agent" className="text-sm font-semibold text-ink">Copy for an agent</h3>
              <p className="text-xs text-ink-faint">Paste into Claude Code, Codex or a Nekko agent. It interviews you and files a GitHub issue once you approve it.</p>
            </div>
            <button type="button" className="btn btn-primary shrink-0" onClick={copy} data-testid="feedback-copy">{copied ? 'Copied' : 'Copy prompt'}</button>
          </div>
          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-line px-2 py-1.5 font-mono text-2xs text-ink-faint" aria-label="Prompt that will be copied">{prompt}</pre>
        </section>

        <section className="flex flex-col gap-2 rounded-lg border border-line p-3" aria-labelledby="feedback-note">
          <h3 id="feedback-note" className="text-sm font-semibold text-ink">Quick note</h3>
          {sent === 'sent' ? (
            <div className="flex items-center justify-between gap-3" role="status">
              <p className="text-xs text-ink">Thanks! Your note is on its way to Nekko Labs.</p>
              <button type="button" className="btn btn-ghost shrink-0" onClick={() => setSent('idle')}>Send another</button>
            </div>
          ) : (
            <>
              <textarea
                className="input min-h-24 w-full resize-y text-sm"
                placeholder="What happened, or what would make Nekko Agent better?"
                aria-label="Feedback note"
                value={note}
                maxLength={FEEDBACK_MAX_CHARS * 2}
                onChange={e => setNote(e.target.value)}
                data-testid="feedback-text"
              />
              <label className="flex items-start gap-2.5">
                <Toggle value={includeInfo} onChange={setIncludeInfo} label="Include app info" />
                <span className="text-xs">
                  <span className="font-medium text-ink">Include app info</span>
                  <span className="block text-ink-faint">
                    App, version, OS and version, and CPU type. Nothing that identifies you.
                    {includeInfo && info && <span className="block font-mono text-2xs">{appInfoLine(info).replace(/^App: /, '')}</span>}
                  </span>
                </span>
              </label>
              <div className="flex items-center justify-between gap-3">
                <span className={`text-2xs ${length > FEEDBACK_MAX_CHARS ? 'text-[var(--danger)]' : 'text-ink-faint'}`}>
                  {length > FEEDBACK_MAX_CHARS * 0.9 ? `${length} / ${FEEDBACK_MAX_CHARS}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={length === 0 || length > FEEDBACK_MAX_CHARS || sent === 'sending'}
                  onClick={() => void send()}
                  data-testid="feedback-send"
                >
                  {sent === 'sending' ? 'Sending…' : 'Send'}
                </button>
              </div>
              {error && <p className="text-xs text-[var(--danger)]" role="alert">{error}</p>}
            </>
          )}
        </section>

        <section className="flex items-center justify-between gap-3 rounded-lg border border-line p-3" aria-labelledby="feedback-github">
          <div>
            <h3 id="feedback-github" className="text-sm font-semibold text-ink">GitHub issues</h3>
            <p className="text-xs text-ink-faint">Report a bug or ask for a feature in public, and follow along.</p>
          </div>
          <a
            href={FEEDBACK_ISSUES_URL}
            className="btn btn-outline shrink-0"
            onClick={e => { e.preventDefault(); window.nekko.openPath(FEEDBACK_ISSUES_URL).catch(() => {}); }}
            data-testid="feedback-github"
          >
            Open GitHub
          </a>
        </section>
      </div>
    </Modal>
  );
}
