// Pieces the website scenes share. Selectors follow the app's own labels
// (aria-label, title, data-* attributes), not its CSS classes.

export const COMPOSER = '[contenteditable][data-placeholder]';
export const MODEL_CHIP = '[data-model-chip-name]';
export const CONTEXT_METER = '[aria-label^="Context window:"]';
export const APPROVAL = 'role=alertdialog[name=/^Approval required/]';
export const APPROVE = `${APPROVAL} >> role=button[name="Approve"]`;
export const DONE = '[data-turn-stats] >> nth=-1';
export const LAST_REPLY = '[data-done-row] >> nth=-1';
/** The live tok/s line and the finished stats line, hidden off the benchmark machine. */
export const SPEED = ['[data-reply-status]', '[data-turn-stats]'];

/** The pace every website scene shares. */
export const PACE = { between: 900, glideMs: 800, typeDelay: 55, holdStart: 1500, holdEnd: 2000 };

/** Close the notice a model change opens ("Context on your next reply") and app notices. */
export const dismissNotices = [
  { click: 'role=button[name="Got it"]', optional: true, after: 400, note: 'dismiss a notice' },
  { click: 'role=button[name="Dismiss"]', optional: true, after: 400, note: 'dismiss an app notice' },
];

/** A new agent chat, in `folder` when given (its name in the folder list). */
export function newChat(folder) {
  return [
    { waitFor: 'role=button[name="Create new"]', after: 2500, note: 'app ready' },
    ...dismissNotices,
    { click: 'role=button[name="Create new"]', after: 500 },
    { click: 'role=button[name="Agent"] >> nth=0', after: 1200 },
    ...(folder ? [{ click: `role=group[name="Folders this chat can use"] >> role=checkbox[name=/${folder}/]`, optional: true, after: 400, note: `use ${folder}` }] : []),
    { click: 'button:has-text("Start")', optional: true, after: 1500, note: 'start the chat' },
    { waitFor: COMPOSER, note: 'composer ready' },
  ];
}

/** Pick a model by (part of) its name in the model picker. */
export function pickModel(name, { hoverList = false } = {}) {
  return [
    { click: MODEL_CHIP, note: 'open the model picker' },
    ...(hoverList ? [{ hover: '[data-model-name] >> nth=3', after: 1200, note: 'look down the list' }] : []),
    { click: `[data-model-name]:has-text("${name}") >> nth=0`, note: `pick ${name}` },
    ...dismissNotices,
  ];
}
