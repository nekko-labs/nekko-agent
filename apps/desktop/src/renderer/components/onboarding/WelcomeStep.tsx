import { useOnboardingT } from '../../onboardingMessages.js';
import React from 'react';
import { SetupNekko } from './AboutYouSteps.js';

/**
 * The wizard's hello: Nekko hops in, waves, and says hi between pixel
 * sparkles (CSS keyframes in styles.css, `.setup-welcome`; reduced motion
 * shows the last frame).
 */
export function WelcomeStep() {
  const t = useOnboardingT();
  return (
    <div className="setup-welcome flex flex-col items-center text-center">
      <div className="relative flex h-48 w-64 items-end justify-center" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <span key={i} className={`setup-sparkle setup-sparkle-${i}`} />)}
        <span className="setup-hi">{t('hi')}</span>
        <span className="setup-hop"><SetupNekko size={150} className="setup-wave" /></span>
      </div>
      <span className="setup-shadow" aria-hidden="true" />
      <h1 className="setup-rise mt-8 text-2xl font-semibold tracking-tight">{t('welcome')}</h1>
      <p className="setup-rise mt-3 max-w-md text-base leading-relaxed text-ink-soft">
        {t('welcomeBody')}
      </p>
      <p className="setup-rise mt-4 text-xs text-ink-faint">{t('welcomeTime')}</p>
    </div>
  );
}
