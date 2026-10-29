import React, { useEffect, useState } from 'react';
import { GreetingNekko } from './GreetingNekko.js';

export const GREETING_QUESTIONS = [
  'What should we work on?',
  'What would you like to make?',
  'What can we figure out together?',
  'What’s on your mind?',
  'What could use a fresh pair of eyes?',
  'What would you like to explore?',
  'What can we make simpler?',
  'What idea should we bring to life?',
  'Where should we start?',
  'What would you like a hand with?',
] as const;
export const GREETING_ROTATE_MS = 8000;

/** Local copy only: no model call, persistence, or announcements on each rotation. */
export function CleanStartGreeting({ paused = false }: { paused?: boolean }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (!paused && !motion.matches && !document.hidden) {
        timer = setInterval(() => setIndex(i => (i + 1) % GREETING_QUESTIONS.length), GREETING_ROTATE_MS);
      }
    };
    sync();
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(timer);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [paused]);
  return <div className="clean-start-greeting fade-in" data-clean-start-greeting>
    <GreetingNekko />
    <h2>{GREETING_QUESTIONS[index]}</h2>
  </div>;
}
