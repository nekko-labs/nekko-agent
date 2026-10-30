// Panel 04 "A safe space. Even we can't see in."
// Privacy Shield shows what it replaced in its own panel: the values it
// hides and the message as the model reads it. Only made-up details here.
import { COMPOSER, DONE, LAST_REPLY, PACE, newChat, pickModel } from './_common.mjs';

const SHIELD = '[data-privacy-shield-button]';
const PANEL = 'role=dialog[name="Privacy Shield"]';

export default {
  title: 'Secure: Privacy Shield hides private values',
  ...PACE,
  setup: [
    ...newChat(),
    ...pickModel('GPT-6.1-Sol'),
    { click: SHIELD, after: 600, note: 'open the shield' },
    {
      run: async ({ page }) => {
        const sw = page.locator(`${PANEL} >> role=switch[name="Shield this chat"]`);
        if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
      },
      note: 'shield on',
    },
    { press: 'Escape' },
  ],
  steps: [
    { hover: SHIELD, after: 1500, note: 'the shield is on' },
    { type: 'Draft a polite reminder to Maria Lopez (maria.lopez@example.com, 07700 900123) that her cake order for Saturday is ready.', into: COMPOSER },
    { click: SHIELD, after: 1200, note: 'what the model will read' },
    { hover: `${PANEL} >> ul[aria-label="Values the shield replaces"]`, after: 2000 },
    { click: `${PANEL} >> role=button[name="Show"]`, optional: true, note: 'the whole message as the model reads it' },
    { hover: `${PANEL} >> pre[data-privacy-sent]`, optional: true, after: 2000 },
    { press: 'Escape' },
    { click: COMPOSER, after: 300 },
    { press: 'Enter' },
    { waitFor: DONE, note: 'wait for the reply' },
    { hover: LAST_REPLY, after: 2000, note: 'real details, put back locally' },
  ],
};
