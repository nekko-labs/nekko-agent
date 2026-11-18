import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Browser, FILE, Flyout, OPEN_FILE, SCROLL } from './EdgeVideo.js';
import { Peek, hops, peekTrack } from './Nekko.js';
import { Cap, Cursor, Frame, HeadLogo, Info, Layout, PanelFrame, Ring, Shot, WIN, prog, shown, v } from './ui.js';

/*
 * Video 2: Microsoft Defender SmartScreen on first run ("Windows protected your PC"),
 * opened from Edge's downloads panel over the real nekkoagent.com. The dialog is redrawn
 * third-party UI, matched to Windows 11 captures from 2026-11-16 (collapsed and expanded).
 */

export const SMARTSCREEN_FRAMES = 1050;

/*
 * PLACEHOLDER, NEEDS SIGN OFF: the "we're working on it" line. Confirm the wording and any
 * timing with Phil before this video is published. It deliberately promises no date and no
 * instant fix, since signing alone does not remove the warning straight away.
 */
export const WORKING_ON_IT = "We're setting up Windows signing, so this step will go away over time.";

const CAPTIONS: Cap[] = [
  { from: 0, to: 86, text: 'Opening Nekko Agent for the first time?' },
  { from: 90, to: 238, text: "Windows might show this. That's normal for new apps." },
  { from: 240, to: 388, text: "It appears because Nekko Agent is new and not signed for Windows yet. It doesn't mean a problem was found." },
  { from: 390, to: 508, text: "Don't run cancels the install, so skip that one." },
  { from: 510, to: 628, text: 'Click More info', step: 'Step 1 of 2' },
  { from: 630, to: 778, text: 'Click Run anyway', step: 'Step 2 of 2' },
  { from: 780, to: 898, text: 'Nekko Agent installs and opens. All done!' },
];

const ink = '#1b1b1b';
const body = '#333333';

/*
 * The dialog, at 1.2x the captured size (532 x 498 px). Its colour follows each PC's theme and
 * accent settings; this neutral grey matches the capture without suggesting any one accent.
 */
const GREY = '#b0b0b0';
const DW = 640;
const DH = 600;
const DX = 800 - DW / 2;
const DY = 150;
const BTN_H = 42;
const BTN_TOP = 526;
const RUN = { x: 337, w: 131 };
const DONT = { x: 493, w: 113 };

function SmartScreen({ frame }: { frame: number }) {
  const o = shown(frame, 84, 766);
  if (o <= 0) return null;
  const open = frame >= 604;
  const btn = (label: string, b: { x: number; w: number }) => (
    <div style={{ position: 'absolute', left: b.x, top: BTN_TOP, width: b.w, height: BTN_H, background: '#ffffff', color: ink, display: 'grid', placeItems: 'center', fontSize: 17, fontWeight: 700 }}>{label}</div>
  );
  return (
    <div style={{ position: 'absolute', left: DX, top: DY, width: DW, height: DH, background: GREY, borderRadius: 8, boxShadow: '0 24px 70px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.12)', opacity: o, transform: `scale(${0.98 + 0.02 * prog(frame, 84, 6)})`, fontFamily: WIN, color: ink, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', right: 0, top: 0, width: 55, height: 38, background: '#ffffff', display: 'grid', placeItems: 'center', fontSize: 18 }}>✕</div>
      <div style={{ position: 'absolute', left: 25, top: 26, fontSize: 34 }}>Windows protected your PC</div>
      <div style={{ position: 'absolute', left: 26, top: 92, width: 560, fontSize: 17, lineHeight: 1.4, color: body }}>
        Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.
      </div>
      {!open ? (
        <div style={{ position: 'absolute', left: 26, top: 150, fontSize: 17, textDecoration: 'underline', color: body }}>More info</div>
      ) : (
        <div style={{ position: 'absolute', left: 28, top: 158, fontSize: 17, lineHeight: '29px', color: body, display: 'grid', gridTemplateColumns: '84px auto' }}>
          <div>App:</div><div>{FILE}</div>
          <div>Publisher:</div><div>Unknown publisher</div>
        </div>
      )}
      {open && btn('Run anyway', RUN)}
      {btn('Don’t run', DONT)}
    </div>
  );
}

function Installer({ frame }: { frame: number }) {
  const o = shown(frame, 770, 846);
  if (o <= 0) return null;
  const p = prog(frame, 778, 60);
  return (
    <div style={{ position: 'absolute', left: 560, top: 300, width: 480, height: 190, background: '#fbfbfb', borderRadius: 10, boxShadow: '0 20px 50px rgba(0,0,0,.45)', opacity: o, fontFamily: WIN, color: ink }}>
      <div style={{ height: 40, background: '#f0f0f3', borderRadius: '10px 10px 0 0', display: 'flex', alignItems: 'center', paddingLeft: 16, fontSize: 14 }}>Nekko Agent Setup</div>
      <div style={{ position: 'absolute', left: 28, top: 66, width: 44, height: 44, borderRadius: 9, background: '#190019', display: 'grid', placeItems: 'center' }}><HeadLogo size={32} /></div>
      <div style={{ position: 'absolute', left: 90, top: 76, fontSize: 17 }}>Installing, please wait...</div>
      <div style={{ position: 'absolute', left: 28, top: 136, width: 424, height: 10, borderRadius: 5, background: '#e3e3e8' }}>
        <div style={{ width: `${p * 100}%`, height: '100%', borderRadius: 5, background: '#854F6C' }} />
      </div>
    </div>
  );
}

/** The app opening: a quiet Dusk window with Nekko, no invented copy. */
function AppWindow({ frame }: { frame: number }) {
  const o = prog(frame, 842, 9);
  if (o <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: 230, top: 110, width: 1140, height: 700, background: v('paper'), borderRadius: 12, boxShadow: `0 0 0 1px ${v('line')}, 0 30px 80px rgba(0,0,0,.5)`, opacity: o, transform: `translateY(${(1 - o) * 8}px)`, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 240, bottom: 0, background: v('surface') }} />
      <div style={{ position: 'absolute', left: 240, right: 0, top: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
        <HeadLogo size={110} />
        <div style={{ color: v('ink'), fontSize: 32, fontWeight: 600 }}>Nekko Agent</div>
      </div>
      <div style={{ position: 'absolute', left: 300, right: 60, bottom: 40, height: 64, borderRadius: 16, background: v('surface-2') }} />
    </div>
  );
}

/** Nekko peeks over the screen: above the downloads panel, then over the Windows dialog. */
function smartPeek(frame: number): Peek | null {
  if (frame >= 902) return null;
  const dont = DX + DONT.x + DONT.w / 2;
  const more = DX + 70;
  const { x, rise } = peekTrack(frame, 8, 1300, [
    { f: 90, x: 800 },
    { f: 380, x: dont },
    { f: 506, x: more },
    { f: 630, x: DX + RUN.x + RUN.w / 2 },
    { f: 772, x: 800 },
  ]);
  let look = { x: 0, y: 1 };
  let mood: Peek['mood'] = 'open';
  let lift = 0;
  let headDx = 0;
  if (frame >= 16 && frame < 40) { mood = 'happy'; lift = hops(frame, [18, 30]); }
  if (frame >= 40 && frame < 90) look = { x: -1, y: 1 };
  if (frame >= 240 && frame < 380) lift = hops(frame, [256]);
  if (frame >= 394 && frame < 506) {
    // A soft "not this one": three small head shakes, then a calm blink.
    if (frame >= 418 && frame < 466) headDx = [0, -1, 0, 1][Math.floor((frame - 418) / 4) % 4];
    if (frame >= 466 && frame < 476) mood = 'closed';
  }
  if (frame >= 520 && frame < 630) lift = hops(frame, [602]);
  if (frame >= 640 && frame < 772) lift = hops(frame, [754]);
  if (frame >= 780) { mood = 'happy'; lift = hops(frame, [856, 872], 2); }
  return { x, rise, look, mood, lift, headDx };
}

function SmartScreenStage() {
  const frame = useCurrentFrame();
  const open = { x: OPEN_FILE.x + 40, y: OPEN_FILE.y + 14 };
  const more = { x: DX + 80, y: DY + 166 };
  const run = { x: DX + RUN.x + 90, y: DY + BTN_TOP + 26 };
  const cursorPath: [number, number, number][] = [
    [8, 900, 700], [26, 900, 700], [52, open.x, open.y],
    [80, 1180, 820], [520, 1180, 820], [566, more.x, more.y],
    [640, more.x, more.y], [690, run.x, run.y],
    [770, run.x, run.y], [790, 1200, 820],
  ];
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Browser scroll={SCROLL} dl />
      <Flyout opacity={1 - prog(frame, 80, 5)} done />
      <Ring x={OPEN_FILE.x} y={OPEN_FILE.y} w={OPEN_FILE.w} h={OPEN_FILE.h} from={28} to={64} r={6} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.35)', opacity: shown(frame, 84, 766) }} />
      <SmartScreen frame={frame} />
      <Info x={DX} y={DY - 84} text="New app, not signed yet" from={250} to={386} />
      <Ring x={DX + 22} y={DY + 148} w={86} h={28} from={524} to={602} r={6} />
      <Ring x={DX + RUN.x} y={DY + BTN_TOP} w={RUN.w} h={BTN_H} from={640} to={756} r={4} />
      <Installer frame={frame} />
      <AppWindow frame={frame} />
      <Cursor path={cursorPath} clicks={[60, 600, 752]} from={8} to={800} />
    </AbsoluteFill>
  );
}

export function SmartScreenVideo({ layout }: { layout: Layout }) {
  return (
    <Frame
      layout={layout}
      label="Install help · First run"
      captions={CAPTIONS}
      note="Illustration. Colours can differ with your Windows theme."
      peek={smartPeek}
      sparkle={[852, 900]}
      end={{
        from: 900,
        title: WORKING_ON_IT,
        lines: [
          { text: 'Only download Nekko Agent from nekkoagent.com' },
          { text: 'Open source: github.com/nekko-labs/nekko-agent' },
        ],
      }}
    >
      <SmartScreenStage />
    </Frame>
  );
}

/*
 * The website panel cut: one glide to Open file, one to the whole Windows box (held for both
 * steps, so nothing moves while the user reads), and one back out as the app installs.
 */
const PANEL_SHOTS: Shot[] = [
  { f: 0, x: 1150, y: 300, z: 1.25 },
  { f: 20, x: 1250, y: 220, z: 1.7 },
  { f: 82, x: 800, y: 430, z: 1.22 },
  { f: 770, x: 800, y: 450, z: 1, dur: 30 },
];

function panelPeek(frame: number): Peek | null {
  const p = smartPeek(frame);
  if (!p) return null;
  return { ...p, x: 1640, rise: Math.min(1, Math.max(0, (frame - 8) / 8)), look: p.mood === 'open' ? { x: frame >= 90 ? -1 : 0, y: -1 } : undefined };
}

export function SmartScreenPanelVideo() {
  return (
    <PanelFrame
      captions={CAPTIONS}
      shots={PANEL_SHOTS}
      peek={panelPeek}
      sparkle={[852, 900]}
      end={{
        from: 900,
        title: WORKING_ON_IT,
        lines: [{ text: 'Only download from nekkoagent.com' }],
      }}
    >
      <SmartScreenStage />
    </PanelFrame>
  );
}
