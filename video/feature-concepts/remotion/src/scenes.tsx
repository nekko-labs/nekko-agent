import React from 'react';
import { A1, A2, G, H } from './fusion';
import { B1, B2, B3 } from './svg';
import { C1, C2, C3, C4, C5 } from './game';
import { D, E1, E2, F } from './cloud';
import { C6 } from './orchestra';

export type Scene = { id: string; frames: number; still: number; headline: string; idea: string; C: () => React.ReactElement };
export const SCENES: Scene[] = [
  { id: 'A1-fusion-tokens', frames: 270, still: 236, headline: 'Same task. Less sent.', idea: 'Claude alone vs Claude + Nekko Agent: running token and cost counters.', C: A1 },
  { id: 'A2-fusion-what-leaves', frames: 240, still: 200, headline: 'Same task. Less leaves your machine.', idea: 'Whole file sent vs only the lines needed; the key and emails stay local.', C: A2 },
  { id: 'B1-svg-logo', frames: 270, still: 240, headline: 'Logos and icons. Made locally.', idea: 'A prompt becomes a clean SVG logo, drawn path by path.', C: B1 },
  { id: 'B2-svg-icon-set', frames: 270, still: 240, headline: 'One prompt. A matching set.', idea: 'Six app icons in one style from one prompt.', C: B2 },
  { id: 'B3-svg-edit-by-chat', frames: 270, still: 240, headline: 'Change it by asking.', idea: '"Make it rounder", "two colours only": the SVG updates live.', C: B3 },
  { id: 'C1-game-sprites', frames: 270, still: 220, headline: "Your game's assets. One chat.", idea: 'A fox sprite sheet, idle and run, animating in a preview.', C: C1 },
  { id: 'C2-game-2d-assets', frames: 270, still: 240, headline: "Your game's assets. One chat.", idea: 'Tiles, items and UI for one scene, then assembled.', C: C2 },
  { id: 'C3-game-3d-asset', frames: 270, still: 220, headline: "Your game's assets. One chat.", idea: 'A low-poly treasure chest builds as wireframe, then shades and turns.', C: C3 },
  { id: 'C4-game-audio', frames: 270, still: 220, headline: "Your game's assets. One chat.", idea: 'Jump, coin and hit sounds drawn as waveforms and played.', C: C4 },
  { id: 'C5-game-pipeline', frames: 300, still: 272, headline: "Your game's assets. One chat.", idea: 'One request fans out to four local sub-agents and flows back into one folder.', C: C5 },
  { id: 'C6-game-orchestra', frames: 420, still: 220, headline: 'One plans. Four make.', idea: 'A paid main agent sends four briefs; each local sub-agent makes its asset live (sprite, tiles, 3D chest, sounds); they come back as one playable level.', C: C6 },
  { id: 'D-two-models', frames: 270, still: 250, headline: 'Two models. One pipeline.', idea: 'Parent chat model hands a brief to a local image model; the picture comes back.', C: D },
  { id: 'E1-cloud-sync', frames: 240, still: 210, headline: 'Your chats, everywhere. Encrypted.', idea: 'Chats, library, artifacts and photos sync encrypted between two devices.', C: E1 },
  { id: 'E2-cloud-optional', frames: 270, still: 240, headline: 'Works on its own. Cloud if you want it.', idea: 'Local chat works offline; Nekko Cloud is a switch you turn on.', C: E2 },
  { id: 'F-fleet-pooling', frames: 270, still: 250, headline: 'Three Macs. One brain.', idea: 'Three laptops pool compute to finish one big task about three times sooner.', C: F },
  { id: 'G-privacy-shield', frames: 270, still: 240, headline: 'Use any model. Keep your data.', idea: 'Names, emails and keys masked locally; the model sees placeholders; real values restored.', C: G },
  { id: 'H-model-routing', frames: 300, still: 280, headline: 'Easy parts here. Hard parts there.', idea: 'One request split: simple parts to a local model, hard parts to a frontier model.', C: H },
];
