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
    // Edits go straight into the demo project (which is reset before each
    // take), not a separate worktree, and the worktree notice never opens.
    {
      run: ({ page }) => page.evaluate(async () => {
        const settings = await window.nekko.getSettings();
        await window.nekko.updateSettings({ defaultExecutionMode: 'unified', gitManagement: { ...settings?.gitManagement, mode: 'shared' } });
      }),
      note: 'use the current Git branch',
    },
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
    ...(hoverList ? [{ hover: `[data-model-name]:has-text("${name}") >> nth=0`, after: 1200, note: `point at ${name}` }] : []),
    { click: `[data-model-name]:has-text("${name}") >> nth=0`, note: `pick ${name}` },
    ...dismissNotices,
  ];
}

export const CHECKOUT_NOTICE = 'role=button[name="Close checkout notice"]';
export const QUESTION = 'role=group[name="The agent is asking a question"]';

/**
 * Wait for the reply to finish, approving every action it asks for (pausing
 * on each so the viewer sees it) and taking the first option of any question
 * it asks. The cursor stays still in between.
 */
export const untilDone = {
  note: 'wait for the reply, approving as it goes',
  run: async ({ visible, hover, click, sleep }) => {
    const start = Date.now();
    while (!(await visible(DONE))) {
      if (Date.now() - start > 600000) throw new Error('The reply took over 10 minutes.');
      if (await visible(CHECKOUT_NOTICE)) {
        await click(CHECKOUT_NOTICE);
      } else if (await visible(APPROVE)) {
        await hover(APPROVAL, 1500);
        await click(APPROVE);
        await sleep(800);
      } else if (await visible(`${QUESTION} >> role=radio`)) {
        await hover(QUESTION, 1200);
        await click(`${QUESTION} >> role=radio >> nth=0`);
        await sleep(500);
        await click(`${QUESTION} >> role=button[name=/^Send answer/]`);
        await sleep(800);
      }
      await sleep(400);
    }
  },
};
