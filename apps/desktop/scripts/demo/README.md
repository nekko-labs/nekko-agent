# Scripted demos

Scenes to play in the real app while screen-recording. See `run-demo.mjs` for how to run one, and `scenes/tour.mjs` for the step format.

- `click` / `hover` / `scroll`: a Playwright selector. The real Windows cursor glides there (eased) and clicks with the real mouse, so recorders that follow the cursor (Recordly auto-zoom, click effects) pick it up.
- `type` (with optional `delay` ms per key), `press` (a key), `wait` (ms), `waitFor` (a selector).
- `after` overrides the scene's `between` pause; `optional: true` skips a click whose target is not on screen (first-run tips); `note` is what the console prints.

Rehearse a scene headless with `--dry --url`; it saves a screenshot per step under `scripts/demo/out/` (gitignored) so you can fix selectors without touching the screen.

## Scene options

- `setup`: steps run before recording starts (open the chat, pick the model). Not part of the take.
- `prepare(ctx)`: runs before the app opens; the website scenes reset the demo project with `bakery.mjs` (a git repository at its first commit, with an `old-menu` folder). The project defaults to `E:\dev\demo-bakery` or `~/demo-bakery`; `--project <dir>` or `NEKKO_DEMO_PROJECT` picks another.
- `holdStart` / `holdEnd`: still frames before the first and after the last step.
- `speedSelectors`: readouts hidden unless the run passes `--benchmark` (the machine the numbers were measured on); `--hide-speed` hides them anyway. Steps with `only: 'benchmark'` run only then.
- More step kinds: `type` with `into` (click a field first), `waitGone` (wait until something disappears), `run` (a function given `{ page, project, benchmark }`).

The five website scenes (`control`, `experience`, `fast`, `secure`, `convenient`) share their selectors and pace in `scenes/_common.mjs`.
