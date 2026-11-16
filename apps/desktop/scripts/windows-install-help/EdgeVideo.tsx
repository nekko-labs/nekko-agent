import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { Peek, hops, peekTrack } from './Nekko.js';
import { Cap, Cursor, Frame, HeadLogo, Info, Layout, PanelFrame, Ring, Shot, WIN, prog, shown } from './ui.js';

/*
 * Video 1: the Edge download warning, on the real nekkoagent.com (captured by
 * capture-site.mjs). Edge's chrome, panel, menu and dialog are redrawn third-party UI
 * (Windows 11 light Edge, simplified) and keep their own colours.
 */

export const EDGE_FRAMES = 930;
export const FILE = 'NekkoAgent-0.10.1000-x64.exe';

/** The page area under the toolbar, and how far the site scrolls to bring the download button up. */
const PAGE_TOP = 96;
export const SCROLL = 600;
/** The site's Windows download button, page coordinates from capture-site.mjs (public/site.json). */
const DL = { x: 514, y: 1132, w: 335, h: 52 };
export const DL_STAGE = { x: DL.x, y: PAGE_TOP + DL.y - SCROLL, w: DL.w, h: DL.h };
/** The site's floating header, which stays pinned while the page scrolls. */
const NAV_H = 84;

const CAPTIONS: Cap[] = [
  { from: 0, to: 86, text: 'Downloading Nekko Agent on Windows?' },
  { from: 90, to: 238, text: "You might see this warning. That's normal for new apps." },
  { from: 240, to: 358, text: 'It shows up because Nekko Agent is new and not signed for Windows yet.' },
  { from: 360, to: 468, text: 'Click the ⋯ button', step: 'Step 1 of 3' },
  { from: 470, to: 556, text: 'Click Keep', step: 'Step 2 of 3' },
  { from: 560, to: 688, text: 'Click Show more, then Keep anyway', step: 'Step 3 of 3' },
  { from: 690, to: 808, text: 'Done! Now open the file to install.' },
];

const ink = '#1b1b1b';
const grey = '#616161';
const edgeBlue = '#0f6cbd';

function Icon({ d, x, y, size = 20, color = grey }: { d: string; x: number; y: number; size?: number; color?: string }) {
  return (
    <svg style={{ position: 'absolute', left: x, top: y }} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const I = {
  back: 'M12 4L6 10L12 16',
  refresh: 'M15 6A6 6 0 1 0 16 11 M15 2V6H11',
  download: 'M10 3V13 M6 9L10 13L14 9 M4 17H16',
  more: 'M4 10H4.01 M10 10H10.01 M16 10H16.01',
  trash: 'M4 6H16 M8 6V4H12V6 M6 6L7 17H13L14 6',
  folder: 'M3 6V15H17V8H9L7 6Z',
  search: 'M9 4A5 5 0 1 0 9 14A5 5 0 1 0 9 4 M13 13L17 17',
  pin: 'M8 3H12L11 8L14 11H6L9 8Z M10 11V17',
  star: 'M10 3L12 8H17L13 11L15 16L10 13L5 16L7 11L3 8H8Z',
};

/** Edge's window with nekkoagent.com in it, scrolled `scroll` px. `dl` lights the downloads button. */
export function Browser({ scroll, dl }: { scroll: number; dl: boolean }) {
  const site = staticFile('site.png');
  return (
    <AbsoluteFill style={{ fontFamily: WIN, background: '#0b0c14' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1600, height: 44, background: '#e8e8ec' }} />
      <div style={{ position: 'absolute', left: 14, top: 8, width: 260, height: 36, background: '#f7f7f9', borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', fontSize: 15, color: ink }}>
        <HeadLogo size={18} />
        Nekko Agent
      </div>
      <div style={{ position: 'absolute', left: 0, top: 44, width: 1600, height: 52, background: '#f7f7f9', borderBottom: '1px solid #e1e1e5' }} />
      <Icon d={I.back} x={22} y={60} />
      <Icon d={I.refresh} x={62} y={60} />
      <div style={{ position: 'absolute', left: 104, top: 52, width: 1180, height: 36, borderRadius: 18, background: '#ffffff', border: '1px solid #e1e1e5', display: 'flex', alignItems: 'center', paddingLeft: 18, fontSize: 16, color: ink }}>nekkoagent.com</div>
      <Icon d={I.star} x={1300} y={60} />
      <div style={{ position: 'absolute', left: 1428, top: 52, width: 36, height: 36, borderRadius: 8, background: dl ? 'rgba(15,108,189,.12)' : 'transparent' }} />
      <Icon d={I.download} x={1436} y={60} color={dl ? edgeBlue : grey} />
      <Icon d={I.more} x={1540} y={60} />
      <div style={{ position: 'absolute', left: 0, top: PAGE_TOP, width: 1600, height: 900 - PAGE_TOP, overflow: 'hidden' }}>
        <Img src={site} style={{ position: 'absolute', left: 0, top: -scroll, width: 1600 }} />
        {scroll > 0 && (
          <div style={{ position: 'absolute', left: 0, top: 0, width: 1600, height: NAV_H, overflow: 'hidden' }}>
            <Img src={site} style={{ position: 'absolute', left: 0, top: 0, width: 1600 }} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

function Warn({ x, y }: { x: number; y: number }) {
  return (
    <svg style={{ position: 'absolute', left: x, top: y }} width={30} height={30} viewBox="0 0 20 20">
      <path d="M10 2L19 18H1Z" fill="#f7b500" stroke="#c58b00" strokeWidth={0.8} strokeLinejoin="round" />
      <path d="M10 7V12" stroke="#1b1b1b" strokeWidth={1.8} strokeLinecap="round" />
      <circle cx={10} cy={15} r={1.1} fill="#1b1b1b" />
    </svg>
  );
}

/** The downloads panel under the toolbar button: the warning, or the finished file. */
export function Flyout({ opacity, done, hoverMore = false }: { opacity: number; done: boolean; hoverMore?: boolean }) {
  if (opacity <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: 1080, top: 100, width: 480, height: 196, background: '#ffffff', borderRadius: 10, boxShadow: '0 16px 40px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.06)', opacity, transform: `translateY(${(1 - opacity) * -4}px)`, fontFamily: WIN, color: ink, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 20, top: 16, fontSize: 19, fontWeight: 600 }}>Downloads</div>
      <Icon d={I.folder} x={330} y={18} />
      <Icon d={I.search} x={370} y={18} />
      <Icon d={I.more} x={410} y={18} />
      <Icon d={I.pin} x={448} y={18} />
      <div style={{ position: 'absolute', left: 0, top: 58, width: 480, height: 1, background: '#ececec' }} />
      {!done ? (
        <>
          <div style={{ position: 'absolute', left: 8, top: 66, width: 464, height: 120, borderRadius: 8, background: hoverMore ? '#f3f3f3' : 'transparent' }} />
          <Warn x={20} y={78} />
          <div style={{ position: 'absolute', left: 66, top: 74, width: 316, fontSize: 16, lineHeight: 1.4 }}>
            <b style={{ fontWeight: 600 }}>{FILE}</b> isn't commonly downloaded. Make sure you trust {FILE} before you open it.
          </div>
          <Icon d={I.trash} x={392} y={76} />
          <div style={{ position: 'absolute', left: 422, top: 68, width: 40, height: 36, borderRadius: 6, background: hoverMore ? '#e6e6e6' : 'transparent' }} />
          <Icon d={I.more} x={432} y={76} color={ink} />
        </>
      ) : (
        <>
          <div style={{ position: 'absolute', left: 20, top: 80, width: 32, height: 32, borderRadius: 7, background: '#190019', display: 'grid', placeItems: 'center' }}><HeadLogo size={24} /></div>
          <div style={{ position: 'absolute', left: 66, top: 76, fontSize: 16, fontWeight: 600 }}>{FILE}</div>
          <div style={{ position: 'absolute', left: 66, top: 102, fontSize: 16, color: edgeBlue, textDecoration: 'underline' }}>Open file</div>
        </>
      )}
    </div>
  );
}
/** Where "Open file" sits in the finished panel, in stage coordinates. */
export const OPEN_FILE = { x: 1146, y: 202, w: 78, h: 22 };

const MENU = ['Keep', 'Report this file as safe', 'Learn more', 'Copy download link'];
function Menu({ frame }: { frame: number }) {
  const o = shown(frame, 452, 556, 5);
  if (o <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: 1290, top: 210, width: 260, padding: '6px 0', background: '#ffffff', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06)', opacity: o, fontFamily: WIN, fontSize: 16, color: ink }}>
      {MENU.map((m, i) => (
        <div key={m} style={{ height: 40, display: 'flex', alignItems: 'center', paddingLeft: 18, background: i === 0 && frame >= 520 ? '#f0f0f0' : 'transparent' }}>{m}</div>
      ))}
    </div>
  );
}

/** "Make sure you trust ..." dialog. Collapsed, then expanded by Show more. */
function TrustDialog({ frame }: { frame: number }) {
  const o = shown(frame, 556, 690);
  if (o <= 0) return null;
  const open = frame >= 608;
  const x = 230;
  const y = 180;
  const link = { position: 'absolute' as const, left: x + 28, fontSize: 16, color: edgeBlue, fontFamily: WIN };
  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: PAGE_TOP, width: 1600, height: 900 - PAGE_TOP, background: 'rgba(0,0,0,.45)', opacity: o }} />
      <div style={{ position: 'absolute', left: x, top: y, width: 600, height: open ? 470 : 360, background: '#ffffff', borderRadius: 10, boxShadow: '0 24px 60px rgba(0,0,0,.4)', opacity: o, transform: `scale(${0.98 + 0.02 * prog(frame, 556, 6)})`, fontFamily: WIN, color: ink }}>
        <div style={{ position: 'absolute', left: 28, top: 26, width: 540, fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>Make sure you trust {FILE} before you open it</div>
        <div style={{ position: 'absolute', left: 28, top: 100, width: 540, fontSize: 16, lineHeight: 1.45, color: '#424242' }}>
          Microsoft Defender SmartScreen couldn't verify if this file is safe because it isn't commonly downloaded. Make sure you trust the file you're downloading or its source before you open it.
        </div>
        <div style={{ position: 'absolute', left: 28, top: 214, fontSize: 16, color: '#424242' }}>File name: {FILE}</div>
      </div>
      <div style={{ ...link, top: y + 256, opacity: o }}>{open ? 'Show less ⌃' : 'Show more ⌄'}</div>
      {open && (
        <>
          <div style={{ ...link, top: y + 296, opacity: o }}>Report this app as safe</div>
          <div style={{ ...link, top: y + 332, opacity: o }}>Learn more</div>
          <div style={{ ...link, top: y + 368, opacity: o, fontWeight: 600 }}>Keep anyway</div>
        </>
      )}
      <div style={{ position: 'absolute', left: x + 330, top: y + (open ? 410 : 300), display: 'flex', gap: 12, opacity: o, fontFamily: WIN, fontSize: 16 }}>
        <div style={{ width: 110, height: 36, borderRadius: 6, background: edgeBlue, color: '#fff', display: 'grid', placeItems: 'center' }}>Delete</div>
        <div style={{ width: 110, height: 36, borderRadius: 6, border: '1px solid #d1d1d1', background: '#fff', display: 'grid', placeItems: 'center' }}>Cancel</div>
      </div>
    </>
  );
}

/** Nekko peeks over the screen: above the site's button, then the downloads panel, then the dialog. */
function edgePeek(frame: number): Peek | null {
  if (frame >= 812) return null;
  const { x, rise } = peekTrack(frame, 8, 760, [
    { f: 92, x: 1300 },
    { f: 560, x: 560 },
  ]);
  let look = { x: -1, y: 1 };
  let mood: Peek['mood'] = 'open';
  let lift = 0;
  if (frame >= 16 && frame < 40) { mood = 'happy'; lift = hops(frame, [18, 30]); }
  if (frame >= 62) look = { x: 1, y: 1 };
  if (frame >= 100) look = { x: 0, y: 1 };
  if (frame >= 240 && frame < 360) lift = hops(frame, [252]);
  if (frame >= 370 && frame < 468) { look = { x: 1, y: 1 }; lift = hops(frame, [452]); }
  if (frame >= 470 && frame < 556) lift = hops(frame, [550]);
  if (frame >= 572 && frame < 690) { look = { x: -1, y: 1 }; lift = hops(frame, [606, 676]); }
  if (frame >= 690) { mood = 'happy'; lift = hops(frame, [698, 714], 2); }
  return { x, rise, look, mood, lift };
}

function EdgeStage() {
  const frame = useCurrentFrame();
  const scroll = Math.round(SCROLL * prog(frame, 14, 26));
  const cx = DL_STAGE.x + DL_STAGE.w / 2;
  const cy = DL_STAGE.y + DL_STAGE.h / 2;
  const cursorPath: [number, number, number][] = [
    [10, 1000, 820], [38, 1000, 820], [56, cx - 60, cy + 6],
    [370, cx - 60, cy + 6], [412, 1522, 186],
    [470, 1522, 186], [518, 1360, 232],
    [566, 1360, 232], [598, 372, 458],
    [612, 372, 458], [660, 372, 570],
    [700, 372, 570], [740, 1200, 218],
  ];
  const warnShown = prog(frame, 70, 6);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Browser scroll={scroll} dl={frame >= 62} />
      <Ring x={DL_STAGE.x} y={DL_STAGE.y} w={DL_STAGE.w} h={DL_STAGE.h} from={40} to={64} r={14} />
      <Flyout opacity={warnShown} done={frame >= 688} hoverMore={frame >= 400 && frame < 556} />
      <Info x={1146} y={312} text="New app, not signed yet" from={248} to={356} />
      <Ring x={1500} y={166} w={44} h={40} from={380} to={452} />
      <Menu frame={frame} />
      <Ring x={1290} y={216} w={260} h={40} from={474} to={550} r={6} />
      <TrustDialog frame={frame} />
      <Ring x={252} y={432} w={130} h={30} from={570} to={606} r={6} />
      <Ring x={252} y={544} w={120} h={30} from={616} to={680} r={6} />
      <Ring x={OPEN_FILE.x} y={OPEN_FILE.y} w={OPEN_FILE.w} h={OPEN_FILE.h} from={724} to={806} r={6} />
      <Cursor path={cursorPath} clicks={[60, 450, 548, 604, 674, 752]} from={10} to={806} />
    </AbsoluteFill>
  );
}

export function EdgeVideo({ layout }: { layout: Layout }) {
  return (
    <Frame
      layout={layout}
      label="Install help · Downloading"
      captions={CAPTIONS}
      note="Illustration. Your browser may look a little different."
      peek={edgePeek}
      sparkle={[696, 806]}
      end={{
        from: 810,
        title: 'Only download Nekko Agent from nekkoagent.com',
        lines: [
          { text: 'Open source: github.com/nekko-labs/nekko-agent' },
          { text: 'Using Chrome? Look for Keep in your downloads.', info: true },
        ],
      }}
    >
      <EdgeStage />
    </Frame>
  );
}

/*
 * The website panel cut. Each new thing appears with the whole screen in view, then the
 * camera eases in on it and holds while it is clicked, and eases out for the next scene.
 */
const PANEL_SHOTS: Shot[] = [
  { f: 0, x: 800, y: 520, z: 1.12 },
  { f: 74, x: 1250, y: 240, z: 1.75 },
  { f: 560, x: 560, y: 420, z: 1.35 },
  { f: 690, x: 1250, y: 220, z: 1.75 },
  { f: 790, x: 800, y: 450, z: 1, dur: 30 },
];

/** Nekko stays put over the caption strip, on the right, and looks towards what is happening. */
function panelPeek(frame: number): Peek | null {
  const p = edgePeek(frame);
  if (!p) return null;
  const left = frame >= 560 && frame < 690;
  return { ...p, x: 1600, rise: Math.min(1, Math.max(0, (frame - 8) / 8)), look: p.mood === 'open' ? { x: left ? -1 : 0, y: -1 } : undefined };
}

export function EdgePanelVideo() {
  return (
    <PanelFrame
      captions={CAPTIONS}
      shots={PANEL_SHOTS}
      peek={panelPeek}
      sparkle={[696, 806]}
      end={{
        from: 810,
        title: 'Only download from nekkoagent.com',
        lines: [
          { text: 'Open source on GitHub' },
          { text: 'Using Chrome? Look for Keep.', info: true },
        ],
      }}
    >
      <EdgeStage />
    </PanelFrame>
  );
}
