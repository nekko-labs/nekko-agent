// Panel 01 "Your models. Your data. Nothing hidden."
import { resetBakery } from '../bakery.mjs';
import { COMPOSER, CONTEXT_METER, LAST_REPLY, MODEL_CHIP, PACE, askFirst, effort, newChat, pickModel, untilDone } from './_common.mjs';

// The local model it starts on; NEKKO_DEMO_LOCAL_MODEL picks another (part of its name).
const LOCAL = process.env.NEKKO_DEMO_LOCAL_MODEL || 'Qwen3-4B';
// The context breakdown that opens beside the meter: by source, with the total.
const BREAKDOWN = `${CONTEXT_METER} + [role=tooltip]`;

export default {
  title: 'In control: pick the model, see the context, approve the action',
  ...PACE,
  // Smaller than the default so the context breakdown stays readable at 960px wide.
  windowSize: '1280x720',
  prepare: (ctx) => resetBakery(ctx.project),
  setup: [...newChat('demo-bakery'), ...pickModel(LOCAL), effort('low'), askFirst],
  steps: [
    { hover: MODEL_CHIP, after: 1500, note: 'the local model, free' },
    ...pickModel('Opus', { hoverList: true }),
    { hover: MODEL_CHIP, after: 1000 },
    { type: 'Add a "Seasonal specials" section to index.html with three autumn bakes.', into: COMPOSER },
    { press: 'Enter', after: 1500 },
    // A new chat shows the meter once its first message is in. Clicking it
    // keeps the breakdown open (and gives Recordly a click to zoom on).
    { click: CONTEXT_METER, note: 'open the context breakdown' },
    { hover: `${BREAKDOWN} >> text=Free space`, after: 1500, note: 'what is in the context, by source' },
    { hover: `${BREAKDOWN} >> text=Total in use`, after: 1500, note: 'the token count' },
    { run: ({ page }) => page.evaluate(() => document.activeElement?.blur()), note: 'close the breakdown' },
    // While it thinks and streams, rest on the reply so the zoom follows the text.
    { hover: '[data-reply-status]', optional: true, after: 300, note: 'follow the reply' },
    untilDone,
    { hover: LAST_REPLY, after: 2000, note: 'the reply and its model' },
  ],
};
