import React from 'react';
import { Player } from '@remotion/player';
import { ExperienceDemo } from './ExperienceDemo.js';
import { ModeSwitch } from '../ModeViews.js';

export function ExperienceStep() {
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return <div className="mx-auto w-full max-w-2xl">
    <h1 className="text-center text-2xl font-semibold">Customize your experience</h1>
    <p className="mt-2 text-center text-sm text-ink-soft">A focused summary or the working details—you choose. Both modes have the same capabilities.</p>
    <div className="my-5 overflow-hidden rounded-xl border border-line">
      <Player component={ExperienceDemo} durationInFrames={240} compositionWidth={640} compositionHeight={380} fps={30} loop autoPlay={!reduceMotion} controls style={{ width: '100%' }} />
    </div>
    <div className="flex justify-center"><ModeSwitch labels /></div>
    <p className="mt-4 text-center text-xs leading-relaxed text-ink-soft">This choice applies now and stays on this device. Open View options → Customize any time for tone, visual preferences, monitors, connectors and skills. It never changes tool permissions.</p>
  </div>;
}
