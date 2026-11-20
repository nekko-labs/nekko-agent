// X posts at 30 fps.
//   GtaIdleGpu: square 1080x1080, 12 s. Console players: put the idle PC to work.
import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { GTA_FRAMES, GtaIdleGpu } from './gta';

registerRoot(() => (
  <Composition id="GtaIdleGpu" component={GtaIdleGpu} durationInFrames={GTA_FRAMES} fps={30} width={1080} height={1080} />
));
