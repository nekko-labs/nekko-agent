import React, { useEffect, useState } from 'react';
import type { AskAnswer, AskRequest } from '@nekko-agent/shared';
import { QuestionCard } from './QuestionCard.js';

/** Retain the last question for the exit transition without keeping it interactive. */
export function ComposerQuestion({ request, onAnswer }: { request: AskRequest | null; onAnswer: (answers: AskAnswer[]) => void }) {
  const [shown, setShown] = useState(request);
  useEffect(() => {
    if (request) { setShown(request); return; }
    const timer = window.setTimeout(() => setShown(null), 180);
    return () => window.clearTimeout(timer);
  }, [request]);
  const current = request ?? shown;
  if (!current) return null;
  return <div className={`composer-question ${request ? 'is-open' : 'is-closing'}`} aria-hidden={!request || undefined} inert={!request || undefined}>
    <div className="composer-question-body"><QuestionCard key={current.callId} request={current} onAnswer={onAnswer} onSkip={() => onAnswer([])} /></div>
  </div>;
}
