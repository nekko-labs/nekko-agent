# Beginner composer prototypes (focused view)

Four interactive takes on the empty focused-view chat — the `cleanStart` state in
`apps/desktop/src/renderer/components/ChatPane.tsx` — for someone writing their
first prompt. Glass/prism styling, light and dark, with a side-by-side mode.
Open [index.html](index.html) in a browser. Design only; no app code changes.

| | Prototype | Idea | Best used as |
| --- | --- | --- | --- |
| A | Prism + coach | Gemini-style frosted composer over drifting light. A coach tray under the prompt is one closed line by default (four colored segments and the next part to add). Open, it says a good prompt has four parts, ticks off Goal / Where / Done when / Limits, and shows a tip. The user's own words that cover each part are tinted in that part's color. Starters only open a sentence. | Default clean-start look for everyone |
| B | Sentence builder | The prompt is one sentence with editable slots (action, thing, where, when done) plus add-ons; a live preview shows exactly what Nekko reads | Opt-in “Help me write it” view |
| C | Prompt coach (now part of A) | A prism ring fills as the prompt gains Goal / Where / Done when / Limits; clicking an unlit part appends a scaffold with a blank | Layer over A while Beginner mode is on |
| D | Guided steps | Nekko asks three questions (kind of help, one-line detail, how hands-on), writes the prompt and sets the chat mode | The first chat after onboarding, once |

## Recommendation

Ship A, with its coach tray, as the clean-start shell. The tray starts closed,
pulses "Show tips" once after a pause while parts are missing, and offers "Keep
tips open" after it has helped. It opens by default while a `beginnerMode`
setting (turned on by onboarding) is set or the user chose to keep it open. and show D once after the onboarding
wizard's Done step. B teaches structure best but costs the most and gets in an
expert's way; keep it as a stretch goal.

## Implementation notes

- Gate everything on the existing `cleanStart` condition so it only shows for an
  empty focused chat with a model ready and nothing waiting on the user.
- Glass over animated color repaints every frame. Animate orbs with `transform`
  only, pause when the window is hidden or unfocused, honour reduced motion, and
  measure with `npm run perf` before shipping (log it in `docs/perf-history.md`).
- The keyword matching should be pure `partSpans(text)` / `partsFound()` beside
  `composerSkills.ts`, run on `deferredDraft` so typing stays at full speed. The
  keyword lists need a Japanese set too.
- "Keep tips open" belongs in settings, not localStorage, so it follows the user
  across windows and devices.
- Localize B's sentence as whole templates, not fragments, since word order differs
  between English and Japanese.

## Open questions

- Should starters (A) be per project, read from `AGENTS.md` or recent chats?
- When does Beginner mode switch itself off: a count of sends, or complete prompts?
- Should the coach optionally ask a small local model to grade the parts after the
  user pauses, so keyword misses ("should I…?" counting as Done when) are caught?
