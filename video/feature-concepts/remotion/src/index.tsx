import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { Stage } from './ckit';
import { SCENES } from './scenes';
import { GLaunch, LAUNCH_FRAMES } from './launch';
import { WhatIs, WHATIS_FRAMES } from './whatis';

registerRoot(() => (
  <>
    {SCENES.flatMap((s) =>
      (['dark', 'light'] as const).map((theme) => {
        const C = () => <Stage theme={theme} frames={s.frames}><s.C /></Stage>;
        return <Composition key={`${s.id}-${theme}`} id={`${s.id}-${theme}`} component={C} durationInFrames={s.frames} fps={30} width={1280} height={720} />;
      }),
    )}
    <Composition id="what-is-nekko" component={WhatIs} durationInFrames={WHATIS_FRAMES} fps={30} width={1280} height={720} />
    <Composition id="G-launch" component={GLaunch} durationInFrames={LAUNCH_FRAMES} fps={30} width={1280} height={720} />
  </>
));
