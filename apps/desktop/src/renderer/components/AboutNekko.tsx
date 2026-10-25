import React, { useEffect, useState } from 'react';
import { NekkoAvatar } from './Mascot.js';
import { useUpdater } from './UpdateBanner.js';
import { Modal } from './primitives/index.js';
import { openFeedback } from './FeedbackSheet.js';

const FACTS = [
  { k: 'Local-first', v: 'Your chats, files and memory stay on this machine unless you send them somewhere.' },
  { k: 'Any model', v: 'Cloud accounts, LM Studio, or the built-in engine. Switch per chat.' },
  { k: 'Cat-powered', v: 'One pixel cat, nine lives, zero telemetry.' },
];

const PURRS = ['purr…', 'mrrp!', 'nya~', '*slow blink*', 'feed me tokens', '=^.^='];

/**
 * The About page, opened from the macOS app menu ("About Nekko Agent") via a
 * `nekko-agent://about` link. A modal over whatever view is showing, so it
 * needs no route or nav entry of its own.
 */
export function AboutNekko() {
  const [open, setOpen] = useState(false);
  const [purr, setPurr] = useState<string | null>(null);
  const version = useUpdater().app?.version;
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('nekko:about', show);
    return () => window.removeEventListener('nekko:about', show);
  }, []);
  if (!open) return null;
  const pet = () => setPurr(PURRS[(PURRS.indexOf(purr ?? '') + 1) % PURRS.length]);
  return (
    <Modal title="About Nekko Agent" onClose={() => { setOpen(false); setPurr(null); }} overlayClassName="p-4" zIndex={100} className="card about-nekko w-[420px] max-w-[92vw] shadow-xl">
      <div className="flex flex-col items-center gap-3 px-6 pb-6 pt-2 text-center">
        <button type="button" className="about-nekko-cat relative" onClick={pet} title="Pet the cat" aria-label="Pet the cat">
          <NekkoAvatar size={72} title="Nekko" />
          {purr && <span key={purr} className="about-nekko-purr" aria-live="polite">{purr}</span>}
        </button>
        <h2 className="text-gradient text-[26px] font-semibold tracking-tight">Nekko Agent</h2>
        {version && <span className="chip text-[11px]">v{version}</span>}
        <p className="text-[13px] text-ink-soft">A local-first agent for chat, cowork and code, with a cat for a co-pilot.</p>
        <ul className="mt-1 flex w-full flex-col gap-2 text-left">
          {FACTS.map(f => (
            <li key={f.k} className="rounded-lg border border-line px-3 py-2">
              <span className="text-[12px] font-semibold text-ink">{f.k}</span>
              <span className="block text-[12px] text-ink-faint">{f.v}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[12px] text-ink-faint">
          Built with care (and catnip) by <span className="font-semibold text-ink">Nekko Labs</span>.
        </p>
        <button type="button" className="btn btn-outline" onClick={() => { setOpen(false); setPurr(null); openFeedback(); }}>Send feedback</button>
        <p className="text-[11px] text-ink-faint">© {new Date().getFullYear()} Nekko Labs</p>
      </div>
    </Modal>
  );
}
