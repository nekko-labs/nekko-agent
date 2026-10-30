// Panel 01 "Your models. Your data. Nothing hidden."
import { resetBakery } from '../bakery.mjs';
import { COMPOSER, CONTEXT_METER, LAST_REPLY, MODEL_CHIP, PACE, effort, newChat, pickModel, untilDone } from './_common.mjs';

// The local model it starts on; NEKKO_DEMO_LOCAL_MODEL picks another (part of its name).
const LOCAL = process.env.NEKKO_DEMO_LOCAL_MODEL || 'Qwen3-4B';

export default {
  title: 'In control: pick the model, see the context, approve the action',
  ...PACE,
  prepare: (ctx) => resetBakery(ctx.project),
  setup: [...newChat('demo-bakery'), ...pickModel(LOCAL), effort('low')],
  steps: [
    { hover: MODEL_CHIP, after: 1500, note: 'the local model, free' },
    ...pickModel('Opus', { hoverList: true }),
    { hover: MODEL_CHIP, after: 1000 },
    { type: 'Add a "Seasonal specials" section to index.html with three autumn bakes.', into: COMPOSER },
    { press: 'Enter', after: 1200 },
    // A new chat shows no context meter until its first message; its breakdown
    // opens on hover: what this chat sends, by source.
    { hover: CONTEXT_METER, optional: true, after: 2500, note: 'what was sent' },
    untilDone,
    { hover: LAST_REPLY, after: 2000, note: 'the reply and its model' },
  ],
};
