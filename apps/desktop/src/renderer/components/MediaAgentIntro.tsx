import React, { useEffect, useState } from 'react';
import { Modal } from './primitives/Modal.js';
import './MediaAgentIntro.css';

export type MediaAgentKind = 'image' | 'video';
const keyFor = (kind: MediaAgentKind) => `nekko.media-intro.${kind}.v1`;
const seen = (kind: MediaAgentKind) => { try { return localStorage.getItem(keyFor(kind)) === 'seen'; } catch { return false; } };
export const MEDIA_INTROS = {
  image: {
    name: 'Photo', title: 'Give your idea a picture.', subtitle: 'A little imagination. A frame of your own.',
    benefits: [
      ['Start with a few words', 'Describe a scene, a mood, or an entirely new world.'],
      ['Find the right frame', 'Choose an aspect ratio and a local image model.'],
      ['Keep creating, locally', 'Your computer generates the image and keeps it in this chat.'],
    ],
    limit: 'Requires a compatible local image model. Photo currently creates images from text; editing an existing photo is not supported.',
  },
  video: {
    name: 'Video', title: 'Make room for your story.', subtitle: 'From the first idea to the final frame.',
    benefits: [
      ['Shape the story', 'Develop a concept, script, and shot list together.'],
      ['Work with your footage', 'Ask the agent to inspect or edit files using available tools.'],
      ['Refine in conversation', 'Review the result, then tell Nekko what to change.'],
    ],
    limit: 'Video uses your selected chat model and approved tools. Direct AI video generation is not connected; editing requires suitable tools on your computer.',
  },
} as const;

/** Original vector artwork, not sample generated output or third-party imagery. */
export function MediaArtwork({ kind }: { kind: MediaAgentKind }) {
  return <div className="media-art" data-kind={kind} aria-hidden="true">
    <svg viewBox="0 0 480 240" focusable="false">
      <g transform="translate(30 38) rotate(-9 95 85)"><rect width="180" height="170" rx="32" fill="#e2b1a1" /><circle cx="132" cy="44" r="22" fill="#ffe7b5" /><path d="M0 143L63 63l44 56 36-28 37 52v27H0Z" fill="#7a8d83" /><path d="M0 153l85-39 95 40v16H0Z" fill="#455d61" /></g>
      <g transform="translate(275 37) rotate(9 85 85)"><rect width="170" height="170" rx="32" fill="#a8b6d5" /><circle cx="86" cy="74" r="49" fill="#d6b2e3" /><path d="M0 146l57-55 52 51 33-28 28 25v31H0Z" fill="#5a5c89" /></g>
      <g transform="translate(145 16)"><rect width="190" height="208" rx="38" fill="#35364e" /><circle cx="95" cy="88" r="55" fill="#d4d4b1" /><path d="M0 176l63-72 68 69 59-47v82H0Z" fill="#9aa58b" /><path d="M0 190l70-36 120 39v15H0Z" fill="#737d69" />{kind === 'video' && <g><circle cx="95" cy="104" r="30" fill="#17171e" fillOpacity=".85" /><path d="M88 88l23 16-23 16Z" fill="#fff" /></g>}</g>
    </svg>
  </div>;
}

export function MediaAgentIntro({ kind, onClose }: { kind: MediaAgentKind; onClose: () => void }) {
  const copy = MEDIA_INTROS[kind];
  return <Modal title={`Welcome to ${copy.name}`} onClose={onClose} className="media-intro" overlayClassName="media-intro-overlay">
    <button className="media-intro-close" aria-label={`Close ${copy.name} introduction`} onClick={onClose}>×</button>
    <div className="media-intro-visual"><MediaArtwork kind={kind} /><p className="media-eyebrow">NEKKO / {copy.name.toUpperCase()}</p><h2>{copy.title}</h2><p className="media-subtitle">{copy.subtitle}</p></div>
    <div className="media-intro-content"><ol>{copy.benefits.map(([title, detail], index) => <li key={title}><span className="media-step" aria-hidden="true">0{index + 1}</span><div><h3>{title}</h3><p>{detail}</p></div></li>)}</ol>
      <p className="media-capability">{copy.limit}</p>
      <button className="btn btn-primary media-intro-cta" onClick={onClose}>Try {copy.name}</button>
    </div>
  </Modal>;
}

/** Per-device, per-mode acknowledgement. Escape and close also count as seen. */
export function MediaAgentWelcome({ kind }: { kind: MediaAgentKind }) {
  const [open, setOpen] = useState(false);
  // Portalled dialogs open only after mounting, not during server/static rendering.
  useEffect(() => { setOpen(!seen(kind)); }, [kind]);
  const close = () => {
    try { localStorage.setItem(keyFor(kind), 'seen'); } catch { /* Private storage must not trap someone in onboarding. */ }
    setOpen(false);
  };
  return <>
    <div className="media-agent-label"><strong>{MEDIA_INTROS[kind].name}</strong><button type="button" onClick={() => setOpen(true)}>About {MEDIA_INTROS[kind].name}</button></div>
    {open && <MediaAgentIntro kind={kind} onClose={close} />}
  </>;
}
