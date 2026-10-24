import React from 'react';
import { SECURITY_KEY_UNTESTED_NOTE, UNTESTED_HARDWARE_ISSUES_URL, splitUntestedNote } from '@nekko-agent/shared';

/**
 * The owner's note beside UI the team could not try on real hardware: a
 * quiet caption, "let us know" opening the public issue tracker.
 */
export function UntestedHardwareNote({ note = SECURITY_KEY_UNTESTED_NOTE, className = '' }: { note?: string; className?: string }) {
  const { before, link, after } = splitUntestedNote(note);
  return (
    <p className={`text-[11px] text-ink-faint ${className}`} data-untested-note>
      {before}
      {link && (
        <a className="underline" href={UNTESTED_HARDWARE_ISSUES_URL} target="_blank" rel="noreferrer">
          {link}
        </a>
      )}
      {after}
    </p>
  );
}
