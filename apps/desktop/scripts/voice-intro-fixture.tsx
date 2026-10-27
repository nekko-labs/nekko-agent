// The first-open voice video at full size (1280 by 720), seekable from a sandbox
// through `window.voiceIntro.seek(frame)`. Synthetic page: no bridge, no host.
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import { VoiceIntroVideo, VOICE_INTRO_FPS, VOICE_INTRO_FRAMES, VOICE_INTRO_SIZE } from '../src/renderer/components/VoiceIntro';
import '../src/renderer/styles.css';

function Fixture() {
  const player = useRef<PlayerRef>(null);
  (window as any).voiceIntro = { frames: VOICE_INTRO_FRAMES, fps: VOICE_INTRO_FPS, seek: (frame: number) => player.current?.seekTo(frame) };
  return <Player ref={player} component={VoiceIntroVideo} durationInFrames={VOICE_INTRO_FRAMES} fps={VOICE_INTRO_FPS} compositionWidth={VOICE_INTRO_SIZE.width} compositionHeight={VOICE_INTRO_SIZE.height} style={{ width: VOICE_INTRO_SIZE.width, height: VOICE_INTRO_SIZE.height }} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
