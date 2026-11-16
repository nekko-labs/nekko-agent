import React from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame } from 'remotion';
import { Peek, PeekNekko } from './Nekko.js';
import { EDGE_FRAMES, EdgePanelVideo, EdgeVideo } from './EdgeVideo.js';
import { SMARTSCREEN_FRAMES, SmartScreenPanelVideo, SmartScreenVideo } from './SmartScreenVideo.js';
import { FPS, SIZE } from './ui.js';

const PoseSheet = () => {
  const f = useCurrentFrame();
  const peeks: Peek[] = [
    { x: 0, rise: 1 },
    { x: 0, rise: 1, look: { x: -1, y: 1 } },
    { x: 0, rise: 1, look: { x: 1, y: 1 } },
    { x: 0, rise: 1, mood: 'happy', lift: 2 },
    { x: 0, rise: 0.5 },
    { x: 0, rise: 1, headDx: 1 },
  ];
  return (
    <AbsoluteFill style={{ background: '#0C0B10' }}>
      {peeks.map((p, i) => (
        <React.Fragment key={i}>
          <div style={{ position: 'absolute', left: 120 + i * 290, top: 500, width: 240, height: 200, border: '1.5px solid #854F6C', borderRadius: 16, background: '#16141C' }} />
          <PeekNekko frame={f} x={240 + i * 290} edgeY={501} u={5} peek={p} />
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
};

const EdgeWide = () => <EdgeVideo layout="wide" />;
const EdgeTall = () => <EdgeVideo layout="tall" />;
const SmartWide = () => <SmartScreenVideo layout="wide" />;
const SmartTall = () => <SmartScreenVideo layout="tall" />;

/*
 * Windows install help videos. Render with scripts/render-windows-install-help.mjs.
 * PoseSheet is a still of every Nekko pose, for reviewing her drawings.
 */
registerRoot(() => <>
  <Composition id="EdgeDownload-16x9" component={EdgeWide} durationInFrames={EDGE_FRAMES} fps={FPS} {...SIZE.wide} />
  <Composition id="EdgeDownload-9x16" component={EdgeTall} durationInFrames={EDGE_FRAMES} fps={FPS} {...SIZE.tall} />
  <Composition id="SmartScreen-16x9" component={SmartWide} durationInFrames={SMARTSCREEN_FRAMES} fps={FPS} {...SIZE.wide} />
  <Composition id="SmartScreen-9x16" component={SmartTall} durationInFrames={SMARTSCREEN_FRAMES} fps={FPS} {...SIZE.tall} />
  <Composition id="EdgeDownload-panel" component={EdgePanelVideo} durationInFrames={EDGE_FRAMES} fps={FPS} {...SIZE.wide} />
  <Composition id="SmartScreen-panel" component={SmartScreenPanelVideo} durationInFrames={SMARTSCREEN_FRAMES} fps={FPS} {...SIZE.wide} />
  <Composition id="PoseSheet" component={PoseSheet} durationInFrames={90} fps={30} width={1920} height={1080} />
</>);
