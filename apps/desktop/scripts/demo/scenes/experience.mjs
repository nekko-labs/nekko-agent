// Panel 02 "The power of a terminal. The polish of a great app."
import { resetBakery } from '../bakery.mjs';
import { APPROVAL, COMPOSER, DONE, PACE, newChat, pickModel } from './_common.mjs';

const LINE = '[title="Click to revert this line"] >> nth=0';

export default {
  title: 'No compromise: agent, changes and terminal in one app',
  ...PACE,
  prepare: (ctx) => resetBakery(ctx.project),
  setup: [...newChat('demo-bakery'), ...pickModel('Opus')],
  steps: [
    { type: 'Make the menu prices bold and add a "Gluten free" tag to the almond croissant.', into: COMPOSER },
    { press: 'Enter', after: 4000 },
    // Edits may ask first; let them through for this chat.
    { click: `${APPROVAL} >> role=button[name="Allow all this session"]`, optional: true },
    { waitFor: DONE, note: 'wait for the edits' },
    { click: 'role=button[name=/^Changes/]', after: 1500 },
    { hover: LINE, after: 2000, note: 'the first diff' },
    { scroll: LINE, by: 240, after: 1200 },
    // The app reverts by line: pick a line, then "Revert 1 line".
    { click: LINE, note: 'pick one line to undo' },
    { click: 'role=button[name=/^Revert \\d+ line/]', after: 1000 },
    { click: 'role=button[name="Keep all"]' },
    { click: 'role=button[name="Create new"]', after: 500 },
    { click: 'role=button[name="Terminal"] >> nth=0', after: 1500 },
    { type: 'git status', into: '.xterm >> nth=-1', delay: 70 },
    { press: 'Enter', after: 2000 },
  ],
};
