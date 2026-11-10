import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { ANDROID_DEMOS, ANDROID_FPS, ANDROID_SIZE, ANDROID_STEPS } from './AndroidDemos.js';

/*
 * The render entry for Android's "Send your first prompt" demos, one composition
 * per step and theme, painted with Android's default palette
 * (apps/android/app/src/main/java/com/nekko/android/ui/theme/Theme.kt).
 */
const VARS = {
  light: {
    '--paper': '#fbfbfd', '--surface': '#ffffff', '--surface-2': '#f2f2f7', '--line': '#e8e8ef',
    '--ink': '#17171d', '--ink-soft': '#52525e', '--ink-faint': '#6a6a76',
    '--accent': '#5a2352', '--on-accent': '#ffffff',
  },
  dark: {
    '--paper': '#0c0c11', '--surface': '#16161c', '--surface-2': '#20202a', '--line': '#26262f',
    '--ink': '#eceaf3', '--ink-soft': '#a3a1b0', '--ink-faint': '#8e8e9b',
    '--accent': '#c084b5', '--on-accent': '#0c0c11',
  },
} as const;

registerRoot(() => <>
  {ANDROID_STEPS.flatMap((step) => (['light', 'dark'] as const).map((theme) => {
    const Demo = ANDROID_DEMOS[step.id];
    const Themed = () => <AbsoluteFill style={VARS[theme] as React.CSSProperties}><Demo /></AbsoluteFill>;
    return <Composition key={`${step.id}-${theme}`} id={`FirstPromptAndroid-${step.id}-${theme}`} component={Themed}
      durationInFrames={Math.round(step.seconds * ANDROID_FPS)} fps={ANDROID_FPS} {...ANDROID_SIZE} />;
  }))}
</>);
