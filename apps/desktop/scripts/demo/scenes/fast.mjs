// Panel 03 "Fast. Really fast. Maybe the fastest."
// The panel quotes numbers measured on an RTX 5090. Record it only on that
// machine, with --benchmark; anywhere else the speed readouts stay hidden.
// The model defaults to Gemma 4 12B; NEKKO_DEMO_FAST_MODEL picks another.
import { resetBakery } from '../bakery.mjs';
import { COMPOSER, DONE, LAST_REPLY, PACE, SPEED, newChat, pickModel } from './_common.mjs';

const MODEL = process.env.NEKKO_DEMO_FAST_MODEL || 'Gemma 4 12B';

export default {
  title: 'Fast: a code edit streaming',
  ...PACE,
  speedSelectors: SPEED,
  prepare: (ctx) => resetBakery(ctx.project),
  setup: [...newChat('demo-bakery'), ...pickModel(MODEL)],
  steps: [
    { type: 'Rewrite style.css to use CSS variables for every colour.', into: COMPOSER },
    { press: 'Enter', after: 1500 },
    { hover: LAST_REPLY, optional: true, after: 1500, note: 'the reply streaming' },
    { waitFor: DONE, note: 'wait for the edit' },
    { hover: DONE, after: 2000, only: 'benchmark', note: 'the speed readout' },
    { hover: LAST_REPLY, after: 1000 },
  ],
};
