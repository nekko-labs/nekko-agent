import React from 'react';
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
  'What’s next?',
  'It’s building time.',
  'Hey there. What’s the plan?',
  'Let’s make something good.',
  'Ready when you are.',
  'Got an idea?',
  'Let’s try something new.',
  'What are we dreaming up?',
  'Small steps. Big ideas.',
  'Let’s get into it.',
  'Your next idea starts here.',
  'What shall we untangle?',
  'Let’s get that idea moving.',
  'A fresh chat, a fresh start.',
  'What are we curious about today?',
  'Bring your what-ifs.',
  'Let’s figure it out.',
  'What’s on the drawing board?',
  'Hello again. Let’s make progress.',
  'A little help, a little momentum.',
] as const;

/** A new Photo chat's greetings: about the picture, never about tasks. */
export const PHOTO_GREETINGS = [
  'What should we draw?',
  'What would you like to see?',
  'What picture is in your head?',
  'Let’s make a picture.',
  'Paint it with words.',
  'Picture this.',
  'What are we imagining today?',
  'Describe it, and we’ll draw it.',
] as const;

const pick = (sessionId: string, phrases: readonly string[]) => {
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return phrases[hash % phrases.length];
};

/** Derive copy from saved chat identity, never elapsed time or render count. */
export function greetingForChat(sessionId: string, createdAt?: number, kind: 'agent' | 'photo' = 'agent'): string {
  if (kind === 'photo') return pick(sessionId, PHOTO_GREETINGS);
  const hour = createdAt === undefined ? -1 : new Date(createdAt).getHours();
  const phrases: readonly string[] = hour >= 4 && hour < 10
    ? [...GREETING_QUESTIONS, 'Morning, early bird.', 'Good morning. What’s first?']
    : hour >= 21 || (hour >= 0 && hour < 4)
      ? [...GREETING_QUESTIONS, 'Hey there, night owl.', 'A quiet night for a bright idea.']
      : GREETING_QUESTIONS;
  return pick(sessionId, phrases);
}

/** Bundled local copy: stable across remounts, with no timers or model calls. `title` replaces the greeting (Photo's setup). */
export function CleanStartGreeting({ sessionId = '', createdAt, kind = 'agent', title }: { sessionId?: string; createdAt?: number; kind?: 'agent' | 'photo'; title?: string }) {
  return <div className="clean-start-greeting fade-in" data-clean-start-greeting>
    <GreetingNekko />
    <h2>{title ?? greetingForChat(sessionId, createdAt, kind)}</h2>
  </div>;
}
