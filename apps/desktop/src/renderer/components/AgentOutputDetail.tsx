import React, { useState } from 'react';
import { useExpertMode, useSimpleChoices } from '../simpleMode.js';
import { currentLevel, MINIMAL_HIDES, type DetailLevel } from './onboarding/aboutYou.js';
import { DetailChoices, DetailPreview } from './onboarding/DetailStep.js';

/** Same presets as setup, saved immediately without changing monitors or permissions. */
export function AgentOutputDetail() {
  const [expert, setExpert] = useExpertMode();
  const [choices, setChoice] = useSimpleChoices();
  const [paused, setPaused] = useState(false);
  const level = currentLevel(expert, choices as Record<string, string>);
  const select = (next: DetailLevel) => {
    setExpert(next === 'detailed');
    for (const id of MINIMAL_HIDES) setChoice(id, next === 'minimal' ? 'hide' : null);
  };
  return <div className="output-detail">
    <DetailChoices level={level} onChange={select} />
    <div className="output-detail-preview">
      <DetailPreview level={level} monitors={false} compact paused={paused} />
      <div className="mt-2 flex items-center justify-between gap-3 text-2xs text-ink-faint">
        <span>Illustrative example, not a live agent run.</span>
        <button type="button" className="output-detail-playback btn btn-ghost shrink-0" onClick={() => setPaused(!paused)}>{paused ? 'Play preview' : 'Pause preview'}</button>
      </div>
    </div>
  </div>;
}
