# Beginner composer prototypes (focused view)

Four interactive takes on the empty focused-view chat — the `cleanStart` state in
`apps/desktop/src/renderer/components/ChatPane.tsx` — for someone writing their
first prompt. Glass/prism styling, light and dark, with a side-by-side mode.
Open [index.html](index.html) in a browser. Design only; no app code changes.

| | Prototype | Idea | Best used as |
| --- | --- | --- | --- |
| A | Prism starters | Gemini-style frosted composer over drifting light; starter cards drop in a template whose `[blanks]` are highlighted, and Tab jumps between them | Default clean-start look for everyone |
| B | Sentence builder | The prompt is one sentence with editable slots (action, thing, where, when done) plus add-ons; a live preview shows exactly what Nekko reads | Opt-in “Help me write it” view |
| C | Prompt coach | A prism ring fills as the prompt gains Goal / Where / Done when / Limits; clicking an unlit part appends a scaffold with a blank | Layer over A while Beginner mode is on |
| D | Guided steps | Nekko asks three questions (kind of help, one-line detail, how hands-on), writes the prompt and sets the chat mode | The first chat after onboarding, once |

## Recommendation

Ship A as the clean-start shell (a restyle of the existing branch), add C's facet
chips and coach behind a `beginnerMode` setting that onboarding turns on and that
retires itself after a few complete prompts, and show D once after the onboarding
wizard's Done step. B teaches structure best but costs the most and gets in an
expert's way; keep it as a stretch goal.

## Implementation notes

- Gate everything on the existing `cleanStart` condition so it only shows for an
  empty focused chat with a model ready and nothing waiting on the user.
- Glass over animated color repaints every frame. Animate orbs with `transform`
  only, pause when the window is hidden or unfocused, honour reduced motion, and
  measure with `npm run perf` before shipping (log it in `docs/perf-history.md`).
- C's heuristics should be a pure `promptFacets(text)` beside `composerSkills.ts`,
  run on `deferredDraft` so typing stays at full speed.
- Localize B's sentence as whole templates, not fragments, since word order differs
  between English and Japanese.

## Open questions

- Should starters (A) be per project, read from `AGENTS.md` or recent chats?
- When does Beginner mode switch itself off: a count of sends, or complete prompts?
- Should C optionally ask a small local model to grade facets after the user pauses?
