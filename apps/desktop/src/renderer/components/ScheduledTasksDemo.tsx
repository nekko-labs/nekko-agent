import React, { useId } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { PeekNekkoArt } from './GreetingNekko.js';

export const SCHEDULED_DEMO_FPS = 30;
export const SCHEDULED_DEMO_SIZE = { width: 960, height: 600 };
export const SCHEDULED_DEMO_SCENES = [
  { start: 0, seconds: 6, title: 'Start with one small job', caption: 'Open Scheduled Tasks. Choose an idea, then make it yours.', transcript: 'Choose Watch a web page for updates under Shopping & web browsing. Enter the page URL and continue to the editor.' },
  { start: 180, seconds: 8, title: 'Tell Nekko what to check', caption: 'Give it a target and clear instructions. This is only a draft.', transcript: 'For this example, read https://example.com/news, summarize important updates with source links, and do not publish anything. Creating a manual task does not run it.' },
  { start: 420, seconds: 7, title: 'Review before you create', caption: 'Check the model, tools and access. Keep the first trigger manual.', transcript: 'Choose an available model with web tools. Review project access and connected services. Instructions are not a security boundary: tool permissions control access.' },
  { start: 630, seconds: 7, title: 'Try it by hand first', caption: 'Create the task, then choose Run. Open the run to follow its progress.', transcript: 'Create scheduled task saves the draft. Run starts it. This illustrative run uses synthetic data and its progress is sped up.' },
  { start: 840, seconds: 8, title: 'Check what came back', caption: 'Read the output and follow the sources before you rely on it.', transcript: 'Inspect the run history and step output. The example report is synthetic, not a live web result. Edit the task and try again if it needs adjustment.' },
  { start: 1080, seconds: 6, title: 'Then make it repeat', caption: 'Add a schedule only when ready. Keep Nekko running for it to fire.', transcript: 'Edit the task, add a schedule trigger, review its timing and save. Online sources need connectivity. Pause all automations stops active runs and prevents automatic starts; manual Run remains available.' },
] as const;
export const SCHEDULED_DEMO_FRAMES = 1260;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ink = 'var(--ink)', soft = 'var(--ink-soft)', accent = 'var(--accent)';

function Row({ label, children, active = false }: { label: string; children: React.ReactNode; active?: boolean }) {
  return <div style={{ border: `1px solid ${active ? accent : 'var(--line)'}`, borderRadius: 12, padding: '14px 20px', background: active ? 'var(--accent-soft)' : 'var(--surface-2)', marginTop: 12 }}>
    <div data-demo-fit style={{ color: soft, fontSize: 17, lineHeight: '24px' }}>{label}</div>
    <div data-demo-fit style={{ fontSize: 25, lineHeight: '34px', fontWeight: 600, overflowWrap: 'anywhere' }}>{children}</div>
  </div>;
}
function Badge({ children }: { children: React.ReactNode }) {
  return <span style={{ color: accent, background: 'var(--accent-soft)', padding: '8px 16px', borderRadius: 9, fontSize: 21, fontWeight: 600 }}>{children}</span>;
}

/** Deterministic illustrated walkthrough, not a recording or an executing task. */
export function ScheduledTasksDemoVideo() {
  const frame = useCurrentFrame();
  const index = SCHEDULED_DEMO_SCENES.reduce((current, s, i) => frame >= s.start ? i : current, 0);
  const scene = SCHEDULED_DEMO_SCENES[Math.max(0, index)];
  const local = frame - scene.start;
  const enter = interpolate(local, [0, 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const leave = index === SCHEDULED_DEMO_SCENES.length - 1 ? 1 : interpolate(local, [scene.seconds * SCHEDULED_DEMO_FPS - 8, scene.seconds * SCHEDULED_DEMO_FPS - 1], [1, 0], clamp);
  const progress = interpolate(local, [52, 112], [0, 1], clamp);
  const finished = local >= 112;
  return <AbsoluteFill data-scheduled-demo-frame={frame} style={{ background: 'var(--paper)', color: ink, fontFamily: 'var(--font-sans, system-ui, sans-serif)', overflow: 'hidden' }}>
    <AbsoluteFill style={{ background: 'var(--nekko-wash, transparent)', opacity: 0.65 }} />
    <div style={{ position: 'absolute', left: 36, right: 36, top: 26, display: 'flex', justifyContent: 'space-between', color: soft, fontSize: 18 }}>
      <span>NEKKO AGENT / SCHEDULED TASKS</span><span>Illustrated walkthrough · {index + 1} / 6</span>
    </div>
    <div style={{ position: 'absolute', left: 36, top: 64, right: 36, display: 'flex', gap: 8 }}>
      {SCHEDULED_DEMO_SCENES.map((s, i) => <div key={s.start} style={{ height: 4, flex: 1, borderRadius: 4, background: i <= index ? accent : 'var(--line)' }} />)}
    </div>
    <div style={{ position: 'absolute', top: 94, left: 44, right: 44, opacity: enter * leave, transform: `translateY(${(1 - enter) * 12}px)` }}>
      <h2 data-demo-fit style={{ margin: 0, fontSize: 38, lineHeight: '48px', letterSpacing: '-0.025em', fontWeight: 650 }}>{scene.title}</h2>
      <div style={{ position: 'relative', marginTop: 38, border: '1px solid var(--line)', borderRadius: 16, background: 'var(--surface)', padding: '20px 26px', height: 262, boxSizing: 'border-box' }}>
        <div style={{ position: 'absolute', right: 26, top: -62, transform: `translateY(${Math.sin(frame / 17) * 2}px)` }}>
          <PeekNekkoArt className="scheduled-demo-nekko" look={{ x: index === 0 ? -1 : 0, y: 1 }} face={index === 4 || (index === 3 && finished) ? 'smile' : undefined} />
        </div>
        <div data-demo-fit style={{ color: soft, fontSize: 17, lineHeight: '24px' }}>Watch a web page for updates</div>
        {index === 0 && <>
          <Row label="Shopping & web browsing" active>Watch a web page for updates</Row>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22 }}><span style={{ color: soft, fontSize: 22 }}>A useful report. No publishing.</span><Badge>Set this up →</Badge></div>
        </>}
        {index === 1 && <>
          <Row label="Page URL">https://example.com/news</Row>
          <p data-demo-fit style={{ fontSize: 23, lineHeight: '32px', margin: '16px 0 0' }}>Summarize important updates with source links.<br />Do not publish anything.</p>
        </>}
        {index === 2 && <>
          <Row label="Model & tools" active>Choose a model with web tools</Row>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 20 }}><Badge>Manual trigger</Badge><span style={{ fontSize: 22, color: soft }}>Review access before saving.</span></div>
          <p style={{ margin: '16px 0 0', fontSize: 18, color: soft }}>Tool permissions control access, not the prompt.</p>
        </>}
        {index === 3 && <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22 }}><Badge>{local < 40 ? 'Create scheduled task' : local < 52 ? 'Run ▷' : finished ? '✓ Completed' : 'Running…'}</Badge><span style={{ fontSize: 18, color: soft }}>Demo progress sped up</span></div>
          <Row label="Read page → summarize → return report" active>{finished ? 'Report ready. Open the run.' : local < 52 ? 'Saved. Nothing runs until you choose Run.' : 'Nekko is working on your report…'}</Row>
          <div style={{ height: 6, marginTop: 22, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}><div style={{ width: `${progress * 100}%`, height: '100%', background: accent }} /></div>
        </>}
        {index === 4 && <>
          <Row label="Step output · synthetic example" active>2 updates worth a look</Row>
          <p data-demo-fit style={{ fontSize: 23, lineHeight: '32px', margin: '14px 0 0' }}>New release notes and an updated guide.<br /><span style={{ color: accent }}>Sources: example.com/news</span></p>
          <p style={{ fontSize: 18, color: soft, margin: '10px 0 0' }}>No live page was checked for this demo.</p>
        </>}
        {index === 5 && <>
          <Row label="Edit task → add a schedule trigger" active>Example: every morning</Row>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 20 }}><Badge>Review timing & save</Badge><span style={{ fontSize: 21, color: soft }}>You choose when it runs.</span></div>
          <p style={{ fontSize: 18, color: soft, margin: '16px 0 0' }}>Pause all automations to stop automatic work.</p>
        </>}
      </div>
    </div>
    <div style={{ position: 'absolute', left: 44, right: 44, bottom: 76, borderTop: '1px solid var(--line)', paddingTop: 18 }}>
      <p data-demo-fit style={{ margin: 0, fontSize: 26, lineHeight: '35px', fontWeight: 500 }}>{scene.caption}</p>
    </div>
  </AbsoluteFill>;
}

/** No autoplay, looping, network embeds or persistent settings changes. */
export function ScheduledTasksDemo({ playerRef }: { playerRef?: React.Ref<PlayerRef> }) {
  const title = useId();
  return <section className="rounded-xl border border-(--line) bg-(--surface-2) p-3" aria-labelledby={title} data-scheduled-tasks-demo>
    <h2 id={title} className="mb-2 text-sm font-medium">See what you can automate <span className="text-xs text-ink-faint">· 42 seconds</span></h2>
    <div className="overflow-hidden rounded-lg border border-(--line)" role="group" aria-label="Scheduled Tasks video player">
      <Player ref={playerRef} component={ScheduledTasksDemoVideo} durationInFrames={SCHEDULED_DEMO_FRAMES} fps={SCHEDULED_DEMO_FPS} compositionWidth={SCHEDULED_DEMO_SIZE.width} compositionHeight={SCHEDULED_DEMO_SIZE.height} style={{ width: '100%', aspectRatio: '960 / 600' }} initialFrame={15} controls showVolumeControls={false} clickToPlay />
    </div>
    <details data-demo-transcript className="mt-2 text-xs leading-relaxed text-ink-soft">
      <summary className="cursor-pointer">Read the walkthrough transcript</summary>
      <ol className="mt-2 list-decimal space-y-2 pl-5">{SCHEDULED_DEMO_SCENES.map(s => <li key={s.start}><strong>{s.title}.</strong> {s.caption} {s.transcript}</li>)}</ol>
      <p className="mt-2">Illustrated with synthetic data. No task is created or run by watching this video. Keep Nekko running; online sources need connectivity.</p>
    </details>
  </section>;
}
