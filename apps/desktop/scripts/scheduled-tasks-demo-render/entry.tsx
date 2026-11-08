import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import '@fontsource-variable/inter-tight';
import { ScheduledTasksDemoVideo, SCHEDULED_DEMO_FPS, SCHEDULED_DEMO_FRAMES, SCHEDULED_DEMO_SIZE } from '../../src/renderer/components/ScheduledTasksDemo.js';

// Default app palettes from styles.css. The in-app player inherits live tokens.
const palettes = {
  light: { '--paper': '#fbfbfd', '--surface': '#ffffff', '--surface-2': '#f2f2f7', '--ink': '#17171d', '--ink-soft': '#52525e', '--line': '#e8e8ef', '--accent': '#5a2352', '--accent-soft': 'color-mix(in srgb, #5a2352 13%, transparent)' },
  dark: { '--paper': '#0c0c11', '--surface': '#16161c', '--surface-2': '#20202a', '--ink': '#eceaf3', '--ink-soft': '#a3a1b0', '--line': '#26262f', '--accent': '#c084b5', '--accent-soft': 'color-mix(in srgb, #c084b5 18%, transparent)' },
};
registerRoot(() => <>{(['light', 'dark'] as const).map(theme => {
  const Video = () => <AbsoluteFill style={{ ...palettes[theme], '--font-sans': 'Inter Tight Variable, sans-serif' } as React.CSSProperties}><ScheduledTasksDemoVideo /></AbsoluteFill>;
  return <Composition key={theme} id={`ScheduledTasks-${theme}`} component={Video} durationInFrames={SCHEDULED_DEMO_FRAMES} fps={SCHEDULED_DEMO_FPS} {...SCHEDULED_DEMO_SIZE} />;
})}</>);
