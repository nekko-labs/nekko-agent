// Panel 05 "Bring local with you." The desktop half: the approval waits
// while you approve it on the paired phone (recorded separately).
import { resetBakery } from '../bakery.mjs';
import { APPROVAL, COMPOSER, DONE, LAST_REPLY, PACE, newChat, pickModel } from './_common.mjs';

export default {
  title: 'Bring local with you: approve from the phone',
  ...PACE,
  // Puts old-menu/ back for every take.
  prepare: (ctx) => resetBakery(ctx.project),
  setup: [...newChat('demo-bakery'), ...pickModel('Opus')],
  steps: [
    { type: 'Delete the old-menu folder.', into: COMPOSER },
    { press: 'Enter' },
    { waitFor: APPROVAL, note: 'approval waiting: approve it on the phone now' },
    { hover: APPROVAL, after: 500 },
    { waitGone: APPROVAL, note: 'approved on the phone' },
    { waitFor: DONE },
    { hover: LAST_REPLY, after: 2000 },
  ],
};
