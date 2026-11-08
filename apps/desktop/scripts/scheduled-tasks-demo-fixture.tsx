// Synthetic wizard and standalone player: no bridge, network, or task execution.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlayerRef } from '@remotion/player';
import { FirstWorkflowWizard } from '../src/renderer/components/FirstWorkflowWizard';
import { ScheduledTasksDemo } from '../src/renderer/components/ScheduledTasksDemo';
import '../src/renderer/styles.css';
function Fixture() {
  const player = useRef<PlayerRef>(null);
  const [video, setVideo] = useState(false);
  (window as any).scheduledDemo = {
    showVideo: setVideo, seek: (frame: number) => player.current?.seekTo(frame),
    play: () => player.current?.play(), pause: () => player.current?.pause(),
    frame: () => player.current?.getCurrentFrame(),
  };
  return video ? <div style={{ maxWidth: 960, margin: '20px auto' }}><ScheduledTasksDemo playerRef={player} /></div> : <FirstWorkflowWizard onCreate={() => { throw Error('Unexpected creation'); }} onBrowse={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
