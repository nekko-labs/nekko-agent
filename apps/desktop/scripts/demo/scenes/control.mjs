// Panel 01 "Your models. Your data. Nothing hidden."
import { resetBakery } from '../bakery.mjs';
import { APPROVAL, APPROVE, COMPOSER, CONTEXT_METER, DONE, LAST_REPLY, MODEL_CHIP, PACE, newChat, pickModel } from './_common.mjs';

export default {
  title: 'In control: pick the model, see the context, approve the action',
  ...PACE,
  prepare: (ctx) => resetBakery(ctx.project),
  setup: [...newChat('demo-bakery'), ...pickModel('Qwen3-4B')],
  steps: [
    { hover: MODEL_CHIP, after: 1500, note: 'the local model, free' },
    ...pickModel('Opus', { hoverList: true }),
    { hover: MODEL_CHIP, after: 1000 },
    // The context meter's breakdown opens on hover: what this chat sends, by source.
    { hover: CONTEXT_METER, after: 2500, note: 'what will be sent' },
    { type: 'Add a "Seasonal specials" section to index.html with three autumn bakes.', into: COMPOSER },
    { press: 'Enter' },
    { waitFor: APPROVAL, note: 'wait for the edit approval' },
    { hover: APPROVAL, after: 1500 },
    { click: APPROVE },
    { waitFor: DONE, note: 'wait for the reply to finish' },
    { hover: LAST_REPLY, after: 2000, note: 'the reply and its model' },
  ],
};
