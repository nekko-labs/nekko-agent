import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

/** An illustrative code task, not a recording or a real agent run. */
export function ExperienceDemo() {
  const frame = useCurrentFrame();
  const detailed = frame >= 120;
  const progress = interpolate(frame % 120, [0, 85], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ background: 'var(--surface)', color: 'var(--ink)', padding: 28, fontFamily: 'var(--font-sans, system-ui)', fontSize: 18 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}><strong>{detailed ? 'Detailed' : 'Simple'}</strong><span style={{ color: 'var(--ink-faint)', fontSize: 14 }}>Illustrative example</span></div>
    <div style={{ padding: 14, borderRadius: 12, background: 'var(--surface-2)' }}>Fix the button so it works with the keyboard.</div>
    {detailed ? <div style={{ fontSize: 14, lineHeight: 1.8, marginTop: 14, color: 'var(--ink-soft)' }}>
      <div>Read Button.tsx</div>
      {progress > 0.25 && <div>Edited the button to use a native element</div>}
      {progress > 0.5 && <pre style={{ padding: 10, background: 'var(--surface-2)', color: 'var(--ink)' }}>{'<button onClick={onSave}>Save</button>'}</pre>}
      {progress > 0.7 && <div>✓ Keyboard interaction test passed</div>}
    </div> : <div style={{ marginTop: 18, color: 'var(--ink-soft)' }}>{progress < 0.7 ? 'Working · 3 steps' : 'Took 3 steps · Show steps'}</div>}
    {progress > 0.7 && <div style={{ marginTop: 18 }}>Fixed. Tab to Save, then press Enter or Space.</div>}
    <div style={{ position: 'absolute', left: 28, bottom: 18, fontSize: 14, color: 'var(--ink-faint)' }}>Same task and result. You choose how much working detail to see.</div>
  </AbsoluteFill>;
}

