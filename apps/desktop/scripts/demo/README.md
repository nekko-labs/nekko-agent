# Scripted demos

Scenes to play in the real app while screen-recording. See `run-demo.mjs` for how to run one, and `scenes/tour.mjs` for the step format.

- `click` / `hover` / `scroll`: a Playwright selector. The real Windows cursor glides there (eased) and clicks with the real mouse, so recorders that follow the cursor (Recordly auto-zoom, click effects) pick it up.
- `type` (with optional `delay` ms per key), `press` (a key), `wait` (ms), `waitFor` (a selector).
- `after` overrides the scene's `between` pause; `optional: true` skips a click whose target is not on screen (first-run tips); `note` is what the console prints.

Rehearse a scene headless with `--dry --url`; it saves a screenshot per step under `scripts/demo/out/` (gitignored) so you can fix selectors without touching the screen.
