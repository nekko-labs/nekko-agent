import React from 'react';
import { Composition, registerRoot, AbsoluteFill } from 'remotion';
import { ExperienceDemo } from '../../src/renderer/components/onboarding/ExperienceDemo';
const Video = () => <AbsoluteFill style={{ '--surface': '#18181b', '--surface-2': '#27272a', '--ink': '#fafafa', '--ink-soft': '#d4d4d8', '--ink-faint': '#a1a1aa' } as React.CSSProperties}><ExperienceDemo /></AbsoluteFill>;
registerRoot(() => <Composition id="Experience" component={Video} durationInFrames={240} fps={30} width={640} height={380} />);
