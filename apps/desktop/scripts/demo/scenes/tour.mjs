// A short tour of the main views. Steps run top to bottom; each waits
// `between` ms afterwards unless it sets its own `after`. Targets are
// Playwright selectors: prefer roles and visible names over CSS classes.
export default {
  title: 'Tour of the main views',
  between: 900,
  glideMs: 750,
  steps: [
    { waitFor: 'role=button[name="Agents"]', after: 3500, note: 'app ready, splash done' },
    { click: 'role=dialog >> role=button[name=/close|skip|got it/i]', optional: true, note: 'dismiss a first-run tip' },
    { click: 'role=button[name=/^Dynamic/]', note: 'dynamic zones' },
    { click: 'role=button[name=/^Focused/]', note: 'focused zones' },
    { click: 'role=button[name="Artifacts"]', after: 1800 },
    { click: 'role=button[name="Workflows"]', after: 1800 },
    { click: 'role=button[name="Models"]', after: 2200 },
    { click: 'role=button[name="Agents"]', after: 1200 },
    { click: 'role=button[name=/search chats/i]' },
    { type: 'release notes', delay: 70, after: 1400 },
    { press: 'Escape' },
  ],
};
