// X posts, square 1080x1080 at 30 fps.
//   GtaIdleGpu: GTA VI is console-only, so put the idle PC GPU to work, 20 s.
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { GTA_FRAMES, GtaIdleGpu } from './gta';

registerRoot(() => (
  <Composition id="GtaIdleGpu" component={GtaIdleGpu} durationInFrames={GTA_FRAMES} fps={30} width={1080} height={1080} />
));
