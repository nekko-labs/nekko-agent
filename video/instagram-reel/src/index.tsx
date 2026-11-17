// Instagram compositions, 1080x1920 at 30 fps.
//   HeroReel: the website hero (intro + speed replay) remade for a phone, 34 s.
//   Reel-dark: a short "pick, ask, approve, done" piece, 20 s.
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { HERO_FRAMES, HeroReel } from './hero';
import { REEL_FRAMES, Reel } from './reel';

registerRoot(() => (
  <>
    <Composition id="HeroReel" component={HeroReel} durationInFrames={HERO_FRAMES} fps={30} width={1080} height={1920} />
    <Composition id="Reel-dark" component={Reel} durationInFrames={REEL_FRAMES} fps={30} width={1080} height={1920} />
  </>
));
