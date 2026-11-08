import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { PHONE_DEMOS, PHONE_FPS, PHONE_SIZE, PHONE_STEPS } from './PhoneDemos.js';

/*
 * The render entry for the iPhone's "Send your first prompt" demos, one
 * composition per step and theme, painted with the iPhone's default palette
 * (apps/ios/App/Platform/Theme.swift, Palette.make with no accent) and
 * AppBackdrop's wash.
 */
const VARS = {
  light: {
    '--paper': '#fbfbfd', '--surface': '#ffffff', '--surface-2': '#f2f2f7', '--line': '#e8e8ef',
    '--ink': '#17171d', '--ink-soft': '#52525e', '--ink-faint': '#5e5e6a',
    '--accent': '#5a2352', '--on-accent': '#ffffff', '--wash-top': '14%',
  },
  dark: {
    '--paper': '#0c0c11', '--surface': '#16161c', '--surface-2': '#20202a', '--line': '#26262f',
    '--ink': '#eceaf3', '--ink-soft': '#a3a1b0', '--ink-faint': '#8e8e9b',
    '--accent': '#c084b5', '--on-accent': '#0c0c11', '--wash-top': '16%',
  },
} as const;

registerRoot(() => <>
  {PHONE_STEPS.flatMap((step) => (['light', 'dark'] as const).map((theme) => {
    const Demo = PHONE_DEMOS[step.id];
    const Themed = () => <AbsoluteFill style={VARS[theme] as React.CSSProperties}><Demo /></AbsoluteFill>;
    return <Composition key={`${step.id}-${theme}`} id={`FirstPrompt-${step.id}-${theme}`} component={Themed}
      durationInFrames={Math.round(step.seconds * PHONE_FPS)} fps={PHONE_FPS} {...PHONE_SIZE} />;
  }))}
</>);
