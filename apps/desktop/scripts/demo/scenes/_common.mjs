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
    // Demo-profile settings every take relies on, then a reload so the app reads them:
    // edits go straight into the demo project (reset before each take) rather
    // than a worktree, no "Reply finished" notifications, Agent Monitor closed.
    {
      run: async ({ page }) => {
        await page.evaluate(async () => {
          const settings = await window.nekko.getSettings();
          await window.nekko.updateSettings({
            defaultExecutionMode: 'unified',
            gitManagement: { ...settings?.gitManagement, mode: 'shared' },
            desktopNotifications: false,
          });
          localStorage.setItem('nekko.planRail', '0');
          localStorage.removeItem('nekko.planRail.sessions');
        });
        await page.reload();
      },
      note: 'demo settings',
    },
    { waitFor: 'role=button[name="Create new"]', after: 2500, note: 'app ready again' },
    // Ctrl+T always makes a new chat; the Create menu's "Agent" reuses the open one.
    { press: 'Control+t', after: 1500, note: 'new chat' },
    { waitFor: '[data-clean-start]', note: 'an empty chat' },
    { waitFor: COMPOSER, note: 'composer ready' },
    // Attach the project folder explicitly: a cloud agent will not run without one.
    ...(folder ? [{
      run: ({ page }) => page.evaluate(async (name) => {
        const id = document.querySelector('[data-session-id]')?.getAttribute('data-session-id');
        const ws = (await window.nekko.getSettings()).workspaces?.find((w) => w.name === name || w.path?.endsWith(name));
        if (!id || !ws) throw new Error(`Add ${name} as a project in the demo profile first.`);
        await window.nekko.setSessionWorkspace(id, ws.id);
      }, folder),
      note: `use ${folder}`,
    }] : []),
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
  run: async ({ page, visible, hover, click, sleep }) => {
    const start = Date.now();
    // Done when a finished reply appears that was not on screen before.
    const finished = () => page.locator('[data-turn-stats]').count();
    const before = await finished();
    while ((await finished()) <= before) {
      if (Date.now() - start > 600000) throw new Error('The reply took over 10 minutes.');
      if (await visible('text=Reply failed')) throw new Error('The reply failed: see the error in the chat.');
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

/**
 * Set this chat's reasoning effort before recording (it keeps its level when
 * the model changes), so a cloud model answers sooner.
 */
export function effort(level) {
  return {
    run: ({ page }) => page.evaluate(async (lvl) => {
      const id = document.querySelector('[data-session-id]')?.getAttribute('data-session-id');
      if (!id) throw new Error('No open chat to set the effort on.');
      await window.nekko.setSessionOptions(id, { effort: lvl });
    }, level),
    note: `effort ${level}`,
  };
}

/** Ask before every file write and command in this chat, so the approval shows. */
export const askFirst = {
  run: ({ page }) => page.evaluate(async () => {
    const id = document.querySelector('[data-session-id]')?.getAttribute('data-session-id');
    if (!id) throw new Error('No open chat to set the approval mode on.');
    await window.nekko.setSessionOptions(id, { mode: 'ask' });
  }),
  note: 'ask before edits and commands',
};
