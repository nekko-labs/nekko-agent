/**
 * Launch-film test: G (Privacy Shield) told as a fast, dramatic product reveal.
 * Seven beats over 16 s: hook, the prompt, the scan, the model, the line, the return, the end card.
 * Black stage, huge type, hard cuts with slams and blur, one plum light that does the work.
 */
import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame, Easing } from 'remotion';
import { Cat, MONO, SANS, clamp, THEMES, Th } from './ckit';
import { fontCss } from '../../../../video/pillars/src/kit';

export const LAUNCH_FRAMES = 480;
const INK = '#f4f2fa', SOFT = '#9d9aab', PLUM = '#c084b5', HOT = '#ff8fd0', BG = '#050507';
const fast = Easing.bezier(0.16, 1, 0.3, 1);
const k = (f: number, a: number, b: number, from: number, to: number) => interpolate(f, [a, b], [from, to], { ...clamp, easing: fast });
const win = (f: number, a: number, b: number) => f >= a && f < b;

/** A word that slams in (big to size, blur to sharp) and optionally leaves upward. */
function Slam({ f, at, out, children, size = 150, style }: { f: number; at: number; out?: number; children: React.ReactNode; size?: number; style?: React.CSSProperties }) {
  if (f < at || (out !== undefined && f >= out + 8)) return null;
  const i = k(f, at, at + 10, 0, 1);
  const o = out === undefined ? 0 : k(f, out, out + 8, 0, 1);
  return (
    <div style={{ fontSize: size, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1, color: INK, opacity: i * (1 - o),
      transform: `scale(${1.35 - 0.35 * i - 0.08 * o}) translateY(${-40 * o}px)`, filter: `blur(${(1 - i) * 18 + o * 12}px)`, whiteSpace: 'nowrap', ...style }}>{children}</div>
  );
}

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&@$';
const scramble = (s: string, seed: string, f: number) => s.split('').map((c, i) => (c === ' ' ? ' ' : GLYPHS[Math.floor(random(`${seed}${i}${Math.floor(f / 2)}`) * GLYPHS.length)])).join('');

/** One private value: real text, scrambled while the beam crosses it, then a placeholder chip. */
function Secret({ f, real, ph, hit, back, glow }: { f: number; real: string; ph: string; hit: number; back?: number; glow: number }) {
  const masked = f >= hit + 8 && (back === undefined || f < back);
  const scr = (f >= hit && f < hit + 8) || (back !== undefined && f >= back && f < back + 8);
  const text = scr ? scramble(real, ph, f) : masked ? ph : real;
  const flash = Math.max(0, 1 - Math.abs(f - (hit + 8)) / 10, back === undefined ? 0 : 1 - Math.abs(f - (back + 8)) / 10);
  return (
    <span style={{ position: 'relative', display: 'inline-block', fontFamily: masked || scr ? MONO : SANS, fontSize: masked || scr ? '0.82em' : '1em',
      color: masked ? PLUM : INK, padding: masked ? '0 0.25em' : 0, borderRadius: 10,
      background: masked ? `rgba(192,132,181,${0.14 + flash * 0.3})` : 'transparent',
      boxShadow: `0 0 ${40 * flash}px rgba(255,143,208,${flash * 0.8})` }}>
      {text}
      {!masked && !scr && <span style={{ position: 'absolute', left: 0, bottom: -6, height: 4, borderRadius: 2, background: HOT, width: `${glow * 100}%`, boxShadow: `0 0 18px ${HOT}` }} />}
    </span>
  );
}

function Glow({ f }: { f: number }) {
  const x = 50 + Math.sin(f / 70) * 18, y = 55 + Math.cos(f / 90) * 10;
  return <AbsoluteFill style={{ background: `radial-gradient(60% 70% at ${x}% ${y}%, rgba(133,79,108,0.28), transparent 70%)` }} />;
}

function Caption({ f, at, out, children }: { f: number; at: number; out: number; children: React.ReactNode }) {
  const o = Math.min(k(f, at, at + 10, 0, 1), 1 - k(f, out - 8, out, 0, 1));
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom: 92, textAlign: 'center', fontFamily: MONO, fontSize: 20, letterSpacing: '0.12em', textTransform: 'uppercase', color: SOFT, opacity: o }}>{children}</div>;
}

export function GLaunch() {
  const f = useCurrentFrame();
  const fade = Math.min(k(f, 0, 8, 0, 1), 1 - k(f, LAUNCH_FRAMES - 14, LAUNCH_FRAMES - 1, 0, 1));
  // Prompt scene (54–270): typed, pushed in, scanned. Secrets keyed to the beam position.
  const showPrompt = win(f, 54, 200);
  const push = k(f, 54, 200, 1, 1.12);
  const beam = k(f, 128, 182, -8, 108); // % across
  const hits = [138, 152, 170];
  const typedN = Math.floor(k(f, 58, 96, 0, 1) * 4); // parts revealed

  return (
    <Th.Provider value={THEMES.dark}>
      <AbsoluteFill style={{ background: BG, fontFamily: SANS, overflow: 'hidden' }}>
        <style>{fontCss}</style>
        <AbsoluteFill style={{ opacity: fade }}>
          <Glow f={f} />

          {/* 1 · Hook */}
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Slam f={f} at={4} out={46}>Every prompt</Slam>
            <Slam f={f} at={20} out={46} style={{ color: PLUM }}>says a lot.</Slam>
          </AbsoluteFill>

          {/* 2–3 · The prompt, then the scan */}
          {showPrompt && (
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${push})`, opacity: 1 - k(f, 190, 200, 0, 1), filter: `blur(${k(f, 190, 200, 0, 14)}px)` }}>
              <div style={{ width: 1040, fontSize: 58, fontWeight: 500, lineHeight: 1.35, letterSpacing: '-0.025em', color: INK }}>
                {typedN >= 1 && <span>Draft a reply to </span>}
                {typedN >= 2 && <Secret f={f} real="Maya Ortiz" ph="[NAME_1]" hit={hits[0]} glow={k(f, 104, 114, 0, 1)} />}
                {typedN >= 2 && <span> at </span>}
                {typedN >= 3 && <Secret f={f} real="maya@ortiz.studio" ph="[EMAIL_1]" hit={hits[1]} glow={k(f, 108, 118, 0, 1)} />}
                {typedN >= 3 && <span> and tell her the new key is </span>}
                {typedN >= 4 && <Secret f={f} real="sk-live-7Hq2vX" ph="[KEY_1]" hit={hits[2]} glow={k(f, 112, 122, 0, 1)} />}
              </div>
              {/* the beam */}
              {f >= 126 && f < 186 && (
                <div style={{ position: 'absolute', top: -100, bottom: -100, left: `${beam}%`, width: 6, background: HOT, boxShadow: `0 0 40px 12px rgba(255,143,208,0.55), 0 0 160px 60px rgba(192,132,181,0.25)` }} />
              )}
            </AbsoluteFill>
          )}
          <Caption f={f} at={104} out={126}>3 private values</Caption>
          <Caption f={f} at={132} out={196}>Shield · masked on your Mac</Caption>

          {/* 4 · The model: rapid cuts */}
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            {win(f, 200, 216) && <Slam f={f} at={200} size={180}>Claude.</Slam>}
            {win(f, 216, 232) && <Slam f={f} at={216} size={180}>Opus 5.5.</Slam>}
            {win(f, 232, 262) && <Slam f={f} at={232} size={180} style={{ color: PLUM }}>Any model.</Slam>}
          </AbsoluteFill>
          {win(f, 200, 262) && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: Math.max(0, 0.18 - ((f - 200) % 16) * 0.03) }} />}

          {/* 5 · What it sees */}
          {win(f, 262, 330) && (
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 40 }}>
              <div style={{ fontFamily: MONO, fontSize: 20, letterSpacing: '0.14em', color: SOFT, opacity: k(f, 262, 272, 0, 1) * (1 - k(f, 300, 308, 0, 1)) }}>WHAT THE MODEL READS</div>
              <div style={{ width: 1040, fontSize: 46, lineHeight: 1.4, color: SOFT, letterSpacing: '-0.02em', opacity: k(f, 264, 276, 0, 1) * (1 - k(f, 300, 308, 0, 1)), transform: `translateY(${k(f, 264, 276, 30, 0)}px)` }}>
                Draft a reply to <span style={{ color: PLUM, fontFamily: MONO }}>[NAME_1]</span> at <span style={{ color: PLUM, fontFamily: MONO }}>[EMAIL_1]</span> and tell her the new key is <span style={{ color: PLUM, fontFamily: MONO }}>[KEY_1]</span>
              </div>
              <div style={{ position: 'absolute' }}><Slam f={f} at={304} out={326} size={130}>It never sees you.</Slam></div>
            </AbsoluteFill>
          )}

          {/* 6 · The return */}
          {win(f, 330, 404) && (
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${k(f, 330, 404, 1.06, 1)})`, opacity: k(f, 330, 340, 0, 1) * (1 - k(f, 396, 404, 0, 1)) }}>
              <div style={{ width: 1040, fontSize: 56, fontWeight: 500, lineHeight: 1.4, letterSpacing: '-0.025em', color: INK }}>
                Hi <Secret f={f} real="Maya" ph="[NAME_1]" hit={322} back={354} glow={0} />, your new key is <Secret f={f} real="sk-live-7Hq2vX" ph="[KEY_1]" hit={322} back={366} glow={0} />. It works from today.
              </div>
            </AbsoluteFill>
          )}
          <Caption f={f} at={350} out={400}>Restored on your Mac</Caption>

          {/* 7 · End card */}
          {f >= 404 && (
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 28 }}>
              <div style={{ opacity: k(f, 404, 418, 0, 1), transform: `scale(${k(f, 404, 422, 0.6, 1)})`, filter: `drop-shadow(0 0 ${30 * k(f, 410, 430, 1, 0.4)}px ${PLUM})` }}><Cat size={120} eyes={f > 440 ? 'happy' : 'open'} /></div>
              <div style={{ textAlign: 'center' }}>
                <Slam f={f} at={412} size={96}>Use any model.</Slam>
                <Slam f={f} at={422} size={96} style={{ color: PLUM }}>Keep your data.</Slam>
              </div>
              <div style={{ fontSize: 24, color: SOFT, opacity: k(f, 434, 446, 0, 1), letterSpacing: '0.02em' }}>Privacy Shield · Nekko Agent</div>
            </AbsoluteFill>
          )}
        </AbsoluteFill>
        <div style={{ position: 'absolute', right: 40, top: 36, fontFamily: MONO, fontSize: 15, color: '#6c6a78', border: '1px solid #26262f', borderRadius: 8, padding: '4px 10px' }}>Concept</div>
      </AbsoluteFill>
    </Th.Provider>
  );
}
