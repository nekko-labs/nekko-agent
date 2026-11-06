import React, { useId, useState } from 'react';
import { inSubagent } from '@nekko-agent/shared';
import './FollowUpChoices.css';

/** Older engines may only return next. Never replace missing choices with generic answers. */
export function followUpOptions(options: unknown, next: string | null): string[] {
  const source = Array.isArray(options) ? options : [];
  const seen = new Set<string>();
  const choices = source.filter((v): v is string => typeof v === 'string')
    .map(v => v.trim().replace(/\s+/g, ' ').slice(0, 120))
    .filter(v => {
      if (!v || seen.has(v.toLowerCase())) return false;
      seen.add(v.toLowerCase());
      return true;
    }).slice(0, 4);
  return choices.length ? choices : next?.trim() ? [next.trim()] : [];
}

/** These are suggested user messages, not an agent question or an approval request. */
export function FollowUpChoices({ options, canDelegate, onSend }: {
  options: string[];
  canDelegate: boolean;
  onSend: (text: string) => void;
}) {
  const [where, setWhere] = useState('here');
  const locationId = useId();
  if (!options.length) return null;
  return (
    <div className="space-y-2 py-2 text-xs" role="group" aria-label="Suggested follow-ups" data-follow-up-choices>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-faint">
        <span>Suggested follow-ups</span>
        {canDelegate && <div className="follow-up-location" role="radiogroup" aria-label="Where to run a suggested follow-up" data-follow-up-location data-where={where}>
          <span className="follow-up-location__thumb" aria-hidden="true" />
          {(['here', 'subagent'] as const).map(location => <label key={location}>
            <input type="radio" name={locationId} value={location} checked={where === location} onChange={() => setWhere(location)} />
            <span>{location === 'here' ? 'This chat' : 'Subagent'}</span>
          </label>)}
        </div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map(text => <button key={text} type="button" className="btn btn-outline max-w-full whitespace-normal py-1 text-left text-xs [overflow-wrap:anywhere]" onClick={() => onSend(canDelegate && where === 'subagent' ? inSubagent(text) : text)}>{text}</button>)}
      </div>
    </div>
  );
}
