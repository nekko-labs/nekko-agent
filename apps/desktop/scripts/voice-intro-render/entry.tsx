import React from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { VoiceIntroVideo, VOICE_INTRO_FPS, VOICE_INTRO_FRAMES, VOICE_INTRO_SIZE } from '../../src/renderer/components/VoiceIntro.js';

/*
 * The render entry for the iPhone's first-open video: the same VoiceIntroVideo
 * the desktop plays, wrapped in the app's light or dark colour variables
 * (styles.css `:root` and `[data-theme='dark']`), since there is no app
 * stylesheet outside the renderer. The component's own fallbacks are the dark
 * values; both are written out so the two themes stay side by side.
 */
const VARS = {
  light: {
    '--surface-2': '#f2f2f7', '--win': '#fcfcfe', '--line': '#e8e8ef',
    '--ink': '#17171d', '--ink-soft': '#52525e', '--ink-faint': '#8a8a97',
    '--accent': '#6d5efc', '--accent-soft': 'color-mix(in srgb, #6d5efc 13%, transparent)',
    '--danger': '#d24738', '--danger-soft': 'color-mix(in srgb, #d24738 14%, transparent)',
  },
  dark: {
    '--surface-2': '#20202a', '--win': '#17171e', '--line': '#26262f',
    '--ink': '#eceaf3', '--ink-soft': '#a3a1b0', '--ink-faint': '#6b6b78',
    '--accent': '#8b7dff', '--accent-soft': 'color-mix(in srgb, #8b7dff 18%, transparent)',
    '--danger': '#e0574a', '--danger-soft': 'color-mix(in srgb, #e0574a 18%, transparent)',
  },
} as const;

const Themed = (theme: keyof typeof VARS) => () => <AbsoluteFill style={VARS[theme] as React.CSSProperties}><VoiceIntroVideo /></AbsoluteFill>;
const Light = Themed('light');
const Dark = Themed('dark');

registerRoot(() => <>
  {(['light', 'dark'] as const).map((id) => (
    <Composition key={id} id={`VoiceIntro-${id}`} component={id === 'light' ? Light : Dark} durationInFrames={VOICE_INTRO_FRAMES} fps={VOICE_INTRO_FPS} {...VOICE_INTRO_SIZE} />
  ))}
</>);
