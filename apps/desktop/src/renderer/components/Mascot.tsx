import React, { useCallback, useEffect, useRef, useState } from 'react';

export type MascotMood = 'idle' | 'waving' | 'thinking';

/** Activity poses map the app's state to one legible piece of cat behavior. */
type MascotPose = 'lying' | 'waking' | 'stretching' | 'bug' | 'sleeping';

/**
 * Hand-drawn outline palette. The ink and paper ride the app's theme tokens,
 * so the drawing works on light and dark chrome without per-theme tuning;
 * ginger stays Aphelion's one spot color (tail and inner ears).
 */
const INK = 'var(--ink)';
const PAPER = 'var(--paper)';
const GINGER = '#f0a35e';
const ACCENT = 'var(--accent)';

const AFK_MS = 60_000;
const STRETCH_MS = 12_000;
const POSE_LABELS: Record<MascotPose, string> = {
  lying: 'Nekko is resting',
  waking: 'Nekko is getting up',
  stretching: 'Nekko is stretching',
  bug: 'Nekko spotted a bug',
  sleeping: 'Nekko is sleeping',
};

/** Coordinate agent activity, user activity, and AFK time without involving the app store. */
function useMascotPose(mood: MascotMood, enabled: boolean): [MascotPose, () => void] {
  const [pose, setPose] = useState<MascotPose>(mood === 'thinking' ? 'bug' : 'waking');
  const moodRef = useRef(mood);
  const afkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { moodRef.current = mood; }, [mood]);

  const armAfk = useCallback(() => {
    if (afkTimer.current) clearTimeout(afkTimer.current);
    if (!enabled || document.hidden) return;
    afkTimer.current = setTimeout(() => {
      if (moodRef.current !== 'thinking') setPose('sleeping');
    }, AFK_MS);
  }, [enabled]);

  const wake = useCallback(() => {
    if (!enabled || document.hidden || moodRef.current === 'thinking') return;
    setPose('waking');
    armAfk();
  }, [armAfk, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (document.hidden) setPose('sleeping');
    else if (mood === 'thinking') setPose('bug');
    else if (mood === 'waving') setPose('waking');
    else setPose((current) => current === 'bug' ? 'stretching' : current === 'sleeping' ? current : 'lying');
    if (mood !== 'thinking') armAfk();
  }, [armAfk, enabled, mood]);

  useEffect(() => {
    if (!enabled || (pose !== 'waking' && pose !== 'stretching')) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      if (!document.hidden && moodRef.current !== 'thinking') setPose('lying');
    }, pose === 'waking' ? 1500 : 1900);
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, [enabled, pose]);

  useEffect(() => {
    if (!enabled) return;
    let lastPointerMove = 0;
    const signalActivity = (event?: Event) => {
      if (event?.type === 'pointermove') {
        const now = Date.now();
        if (now - lastPointerMove < 1000) return;
        lastPointerMove = now;
      }
      setPose((current) => current === 'sleeping' && moodRef.current !== 'thinking' ? 'waking' : current);
      armAfk();
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (afkTimer.current) clearTimeout(afkTimer.current);
        setPose('sleeping');
      } else if (moodRef.current === 'thinking') {
        setPose('bug');
      } else {
        signalActivity();
      }
    };
    window.addEventListener('keydown', signalActivity);
    window.addEventListener('pointerdown', signalActivity);
    window.addEventListener('pointermove', signalActivity, { passive: true });
    window.addEventListener('touchstart', signalActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    armAfk();
    return () => {
      window.removeEventListener('keydown', signalActivity);
      window.removeEventListener('pointerdown', signalActivity);
      window.removeEventListener('pointermove', signalActivity);
      window.removeEventListener('touchstart', signalActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      if (afkTimer.current) clearTimeout(afkTimer.current);
    };
  }, [armAfk, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      if (!document.hidden && moodRef.current !== 'thinking') {
        setPose((current) => current === 'lying' ? 'stretching' : current);
      }
    }, STRETCH_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  return [pose, wake];
}

/** A wobbly four-point sparkle made from two crossed pencil strokes. */
function Sparkle({ x, y, s, color, className }: { x: number; y: number; s: number; color: string; className?: string }) {
  return (
    <g className={className} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
      <path
        d={`M ${x - s} ${y} Q ${x} ${y - 0.4} ${x + s} ${y} M ${x} ${y - s} Q ${x + 0.3} ${y} ${x} ${y + s}`}
        stroke={color}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}

/**
 * The cat-ear helmet dome as a single ink outline. The paper fill isn't a
 * suit color, it occludes whatever is drawn behind the head, the way inked
 * animation handles overlaps.
 */
function AgentHead({ expression = 'awake', sw = 2.2 }: { expression?: 'awake' | 'curious' | 'sleeping'; sw?: number }) {
  const sleeping = expression === 'sleeping';
  return (
    <g data-part="agent-head">
      <path
        data-mascot-accessory="collar"
        d="M 25 44.8 L 31.6 47.2 L 27.9 51.6 L 23.3 47.4 Z M 38.2 44.8 L 31.6 47.2 L 35.3 51.6 L 39.9 47.4 Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
      <path data-mascot-accessory="tie" d="M 30.1 48.3 L 33.1 48.3 L 33.6 50.1 L 31.6 51.5 L 29.6 50.1 Z M 31.6 51.5 L 33.4 53.4 L 31.6 54.8 L 29.8 53.4 Z" fill={INK} />
      <path
        d="M 17 23 C 17.2 18.1 18.2 14.1 19.2 10.7 L 18.9 6.6 Q 19.2 4.7 20.9 6.1 L 31.8 14.2 L 42.2 6.1 Q 43.9 4.7 44.2 6.6 L 43.9 10.7 C 45 14.1 46 18.1 46.2 23 L 46.2 35.1 C 46.2 42.2 40.8 46.7 31.6 46.7 C 22.4 46.7 17 42.2 17 35.1 Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      {/* Ginger inner-ear strokes keep the dome recognizably feline. */}
      <path d="M 21.5 15 L 21.5 9.8 L 27 13.9 M 36.2 13.9 L 41.7 9.8 L 41.7 15" stroke={GINGER} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <g
        data-mascot-accessory="sunglasses"
        data-position={sleeping ? 'perched' : 'worn'}
        transform={sleeping ? 'translate(0 -7.5)' : expression === 'curious' ? 'translate(.8 -.6) rotate(-6 31.6 27)' : undefined}
        fill={INK}
        stroke={INK}
        strokeWidth={1.05}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M 22.3 26.1 L 29.2 26.6 L 28.7 30 Q 26.1 31.6 23 29.8 Z M 33.9 26.6 L 40.8 26.1 L 40.1 29.8 Q 37 31.6 34.4 30 Z" />
        <path d="M 29.1 27.2 Q 31.6 26.1 34 27.2 M 22.4 26.4 L 19.9 25.4 M 40.7 26.4 L 43.1 25.4" fill="none" />
      </g>
      {sleeping ? (
        <>
          <path data-part="closed-eyes" d="M 24.4 29.6 q 2 1.7 4 0 M 34.8 29.6 q 2 1.7 4 0" stroke={INK} strokeWidth={1.6} strokeLinecap="round" fill="none" />
          <path d="M 30 34.2 q 1.6 -0.8 3.2 0" stroke={INK} strokeWidth={1.3} strokeLinecap="round" fill="none" />
        </>
      ) : (
        <path d="M 29.3 33.7 q 1.15 1.35 2.3 0 q 1.15 1.35 2.3 0" stroke={INK} strokeWidth={1.5} strokeLinecap="round" fill="none" />
      )}
      <path d="M 19.3 31.1 q 2.2 0.6 3.8 0.4 M 19.5 34.2 q 2.1 -0.2 3.6 -0.7 M 43.9 31.1 q -2.2 0.6 -3.8 0.4 M 43.7 34.2 q -2.1 -0.2 -3.6 -0.7" stroke={INK} strokeWidth={1.2} strokeLinecap="round" fill="none" opacity={0.55} />
      <path data-mascot-accessory="earpiece" d="M 46.2 27.2 Q 48.7 26.8 48.7 29.1 L 48.7 31.9 Q 48.7 33.8 46.2 33.5" fill={PAPER} stroke={INK} strokeWidth={1.3} strokeLinecap="round" />
      <path data-mascot-accessory="wire" d="M 48.1 33.4 L 48.1 35.5 q 2 1.1 0 2.2 q -2 1.1 0 2.2 q 2 1.1 0 2.2 L 47.3 44.5" fill="none" stroke={INK} strokeWidth={1} strokeLinecap="round" />
    </g>
  );
}

function RestPose({ sleeping = false }: { sleeping?: boolean }) {
  return (
    <g className={sleeping ? 'nekko-sleep' : 'nekko-breathe'}>
      <path data-part="edge" data-edge-length="62" d="M 91 26 L 91 88" stroke={INK} strokeWidth={1.3} strokeLinecap="round" fill="none" opacity={0.32} />
      {/* Tucked front paws peek out under the chest as two little rolls. */}
      {sleeping ? (
        <g data-part="slender-body" data-body-style="line-only" data-torso-width="11" data-stance="slumped">
          <path d="M 64 68 C 52 69 47 62 51 55 C 54 50 59 50 63 53" stroke={GINGER} strokeWidth={2.4} strokeLinecap="round" fill="none" />
          <path data-part="torso" d="M 74 52 Q 72 62 63 69" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
          <path d="M 75 53 Q 84 51 91 47" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
          <path d="M 72 56 Q 62 64 58 73 M 60 75 q -3 2 -6 0" stroke={INK} strokeWidth={1.9} strokeLinecap="round" fill="none" />
          <path d="M 64 68 Q 53 75 43 83 M 46 86 q -4 0 -7 -2" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
          <path d="M 65 69 Q 67 79 74 84 M 77 86 q -4 1 -7 -1" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
          <g transform="translate(41 6) scale(.86)">
            <AgentHead expression="sleeping" />
          </g>
        </g>
      ) : (
        <g data-part="slender-body" data-body-style="line-only" data-torso-width="11" data-stance="leaning">
          <path d="M 61 67 C 48 70 42 61 48 52 C 51 48 56 48 60 51" stroke={GINGER} strokeWidth={2.4} strokeLinecap="round" fill="none" />
          <path data-part="torso" d="M 72 48 Q 69 57 60 67" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
          <path data-part="edge-contact" d="M 74 49 Q 84 48 91 43" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
          <path d="M 70 53 Q 80 58 83 67 M 85 70 q -3 1 -5 -1" stroke={INK} strokeWidth={1.9} strokeLinecap="round" fill="none" />
          <path d="M 68 53 Q 61 61 63 70 M 65 72 q -3 1 -5 -1" stroke={INK} strokeWidth={1.9} strokeLinecap="round" fill="none" />
          <g data-part="crossed-ankles" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none">
            <path d="M 60 67 Q 61 76 67 82 L 57 86 M 60 88 q -4 0 -7 -2" />
            <path d="M 63 67 Q 61 76 56 82 L 67 86 M 70 87 q -4 2 -7 0" />
          </g>
          <g transform="translate(40 -1) scale(.9)">
            <AgentHead />
          </g>
        </g>
      )}
      {sleeping && (
        <g className="nekko-zs" fill={INK} fontFamily="Inter, system-ui, sans-serif" fontWeight="700">
          <text x="96" y="42" fontSize="9">z</text>
          <text x="104" y="30" fontSize="12">z</text>
        </g>
      )}
    </g>
  );
}

function StretchPose() {
  return (
    <g className="nekko-stretch">
      <g data-part="slender-body" data-body-style="line-only" data-torso-width="10" data-stance="stretching">
        <path d="M 35 52 C 25 51 20 46 22 39 C 24 33 20 30 15 32" stroke={GINGER} strokeWidth={2.4} strokeLinecap="round" fill="none" />
        <path data-part="torso" d="M 34 48 Q 50 43 68 51 M 35 57 Q 51 53 67 58" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
        <path d="M 35 52 Q 24 61 15 72 M 18 75 q -4 1 -7 -1" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path d="M 39 55 Q 31 67 25 78 M 28 81 q -4 1 -7 -1" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path d="M 67 56 Q 78 68 91 78 M 94 81 q -4 2 -8 0" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path d="M 70 58 Q 83 67 103 72 M 106 74 q -4 2 -8 0" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <g transform="translate(64 28) scale(.76)">
          <AgentHead expression="sleeping" sw={2.6} />
        </g>
      </g>
    </g>
  );
}

function BugPose() {
  return (
    <g className="nekko-bug-watch">
      <path data-part="edge" data-edge-length="68" d="M 96 14 L 96 82" stroke={INK} strokeWidth={1.3} strokeLinecap="round" fill="none" opacity={0.32} />
      <g data-part="slender-body" data-body-style="line-only" data-torso-width="12" data-stance="peeking">
        <path d="M 64 68 C 52 71 46 64 50 56 C 53 50 57 49 61 52" stroke={GINGER} strokeWidth={2.4} strokeLinecap="round" fill="none" />
        <path data-part="torso" d="M 65 48 Q 60 59 63 70 M 75 49 Q 77 60 72 70" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
        <path d="M 64 69 Q 60 77 61 86 M 64 88 q -4 2 -8 0" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path d="M 72 69 Q 76 77 78 85 M 81 87 q -4 2 -8 0" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        {/* Both front paws brace toward the bug. */}
        <path d="M 71 51 Q 83 43 96 39 M 71 58 Q 84 61 96 57" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <g transform="translate(49 -2) scale(.9)">
          <AgentHead expression="curious" sw={2.4} />
        </g>
      </g>
      <g className="nekko-bug">
        <circle cx={106} cy={24} r={2.4} fill={INK} />
        <path d="M 103 21 L 100 18 M 108 21 L 111 18 M 103 26 L 100 29 M 108 26 L 111 29" stroke={INK} strokeWidth={1.2} strokeLinecap="round" fill="none" />
        <path d="M 103 23 Q 98 21 97 17 M 108 23 Q 112 20 113 17" stroke={GINGER} strokeWidth={1.2} strokeLinecap="round" fill="none" />
      </g>
    </g>
  );
}

function StandPose() {
  return (
    <g>
      <path data-part="edge" data-edge-length="62" d="M 91 26 L 91 88" stroke={INK} strokeWidth={1.3} strokeLinecap="round" fill="none" opacity={0.32} />
      <g className="nekko-stand" data-part="slender-body" data-body-style="line-only" data-torso-width="11" data-stance="pushing-off" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
        <path d="M 64 67 C 51 69 46 61 51 53 C 54 48 59 47 63 50" stroke={GINGER} strokeWidth={2.6} strokeLinecap="round" fill="none" />
        {/* Far legs first so the paper-filled torso occludes their tops. */}
        <path d="M 63 66 Q 59 76 59 85 M 62 88 q -4 1 -8 -1" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path d="M 72 66 Q 75 76 76 84 M 79 87 q -4 2 -8 0" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path data-part="torso" d="M 65 48 Q 61 57 63 67 M 75 49 Q 77 58 72 67" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
        <path d="M 67 53 Q 58 61 58 70 M 60 72 q -3 1 -5 -1" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        <path d="M 73 52 Q 82 47 91 43 M 93 41 q 1 3 -1 5" stroke={INK} strokeWidth={2} strokeLinecap="round" fill="none" />
        {/* Collar line joins the helmet to the body. */}
        <path d="M 64 48 Q 69 50 75 49" stroke={INK} strokeWidth={1.8} strokeLinecap="round" fill="none" />
        <g transform="translate(41 -2) scale(.9)">
          <AgentHead />
        </g>
      </g>
    </g>
  );
}

export type MiniNekkoState = 'idle' | 'thinking' | 'terminal';

export function MiniNekko({ size = 18, state = 'idle' }: { size?: number; state?: MiniNekkoState }) {
  return (
    <span className="inline-block shrink-0 align-middle" data-mini-state={state} style={{ lineHeight: 0 }}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'terminal' ? (
          <g data-part="mini-terminal">
            <rect x="3" y="5" width="26" height="23" rx="2" />
            <path d="M3 11H29 M7 8H8 M11 8H12" />
            <svg x="6" y="14" width="20" height="11" viewBox="0 0 20 11" overflow="hidden">
              <g className="nekko-mini-lines" strokeWidth="1.5">
                <path d="M0 2L2 3.5L0 5 M5 4H13 M0 9H17 M0 14H10 M0 19H15 M0 24H13" />
              </g>
            </svg>
          </g>
        ) : state === 'thinking' ? (
          <g data-part="mini-thought">
            <circle className="nekko-mini-thought-trail" cx="5" cy="27" r="1" fill="currentColor" stroke="none" />
            <circle className="nekko-mini-thought-trail" cx="9" cy="23" r="1.8" style={{ animationDelay: '180ms' }} />
            <g className="nekko-mini-thought-bubble">
              <path d="M10 18C3 18 3 9 9 8C9 2 18 1 21 6C29 4 32 14 26 17C24 23 14 23 10 18Z" />
              {[13, 18, 23].map((x, i) => <circle key={x} className="nekko-mini-thought-dot" cx={x} cy="13" r="1" fill="currentColor" stroke="none" style={{ animationDelay: `${i * 180}ms` }} />)}
            </g>
          </g>
        ) : (
          <g data-part="pixel-head" strokeLinejoin="miter">
            <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" />
            <path data-part="blink-marks" className="nekko-mini-blink" d="M10 17H13 M19 17H22" />
          </g>
        )}
      </svg>
    </span>
  );
}

/**
 * Aphelion's still helmet portrait for the rail, empty states, and login heroes.
 * Same outline dome, ginger inner ears, and face language as the full mascot.
 */
export function NekkoAvatar({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      viewBox="15 3.5 36 53"
      width={size}
      height={(size * 53) / 36}
      fill="none"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <AgentHead />
    </svg>
  );
}

/**
 * Aphelion, a hand-drawn outline cat living at the bottom of the left rail.
 * One ink stroke on the theme's paper, with a turbulence "line boil" that
 * re-seeds a few times a second so the drawing reads as 2D hand-drawn
 * animation. User and agent activity select a right-facing wake, rest,
 * stretch, bug-watch, or sleep pose.
 */
export function Mascot({ mood, enabled }: { mood: MascotMood; enabled: boolean }) {
  const [peek, setPeek] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [pose, wake] = useMascotPose(mood, enabled);
  const thinking = mood === 'thinking';
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => setPeek(true), 400);
    return () => clearTimeout(t);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      className={`pointer-events-none fixed bottom-2 left-0 z-40 flex w-16 select-none items-end justify-center ${peek ? 'nekko-peek' : ''}`}
    >
      <div
        className={`pointer-events-auto cursor-pointer ${hovering ? 'nekko-attentive' : ''} ${typeof document !== 'undefined' && document.hidden ? 'nekko-paused' : ''}`}
        data-mascot-pose={pose}
        onMouseEnter={() => { setHovering(true); wake(); }}
        onMouseLeave={() => setHovering(false)}
        onClick={wake}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wake(); } }}
        title={POSE_LABELS[pose]}
        role="button"
        tabIndex={0}
        aria-label={POSE_LABELS[pose]}
      >
        <div className={pose === 'waking' ? 'nekko-wake' : ''}>
          <svg
            viewBox="0 0 114 92"
            width="108"
            height="87"
            fill="none"
          >
            {/* The cat faces the app, not the rail: one mirror of the whole scene
                (flips the poses, the wall, and the sparkles together, so nothing
                drifts out of place). The wall itself is repositioned below to the
                app's edge. */}
            <g transform="scale(-1 1) translate(-114 0)">
            <defs>
              {/* The line boil: fractal noise displaces every stroke a hair,
                  re-seeding a few times a second, the wobble of traditional
                  frame-by-frame ink. CSS gates it (reduced motion, hidden). */}
              <filter id="nekko-boil" x="-10%" y="-10%" width="120%" height="120%">
                <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="1" result="n">
                  <animate attributeName="seed" values="1;7;13;4;9" dur="0.55s" repeatCount="indefinite" calcMode="discrete" />
                </feTurbulence>
                <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" />
              </filter>
            </defs>
            <Sparkle x={7} y={18} s={2.2} color={GINGER} className={thinking ? 'nekko-twinkle' : 'nekko-twinkle-slow'} />
            <Sparkle x={109} y={41} s={1.8} color={ACCENT} className="nekko-twinkle-slow" />
            <Sparkle x={10} y={78} s={1.6} color={GINGER} className={thinking ? 'nekko-twinkle' : 'nekko-twinkle-slow'} />
            <g className="nekko-boil">
              {pose === 'lying' && <RestPose />}
              {pose === 'sleeping' && <RestPose sleeping />}
              {pose === 'stretching' && <StretchPose />}
              {pose === 'bug' && <BugPose />}
              {pose === 'waking' && <StandPose />}
            </g>
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
