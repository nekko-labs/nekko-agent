# Desktop end-to-end journeys

Playwright drives the real renderer in a hidden Electron window. It replaces the
per-feature `scripts/*-fixture.tsx` / `-integration.cjs` / `-sandbox.cjs` triads.

```
npm run test:e2e -w @nekko-agent/desktop             # all journeys
npm run test:e2e -w @nekko-agent/desktop -- chat-finder   # one spec
```

Output (screenshots, traces, HTML report) goes to the ignored `.shots/e2e/`.
Open `.shots/e2e/report/index.html` to see every `shot()` capture per step.

## How it fits together

| File | Role |
|---|---|
| `playwright.config.ts` | `*.e2e.ts` specs, global build, reporters |
| `global-setup.ts` | Builds `fixture-app.tsx` once (esbuild + Tailwind) into `.shots/e2e/build` |
| `fixture-app.tsx` | One bundle; `?scenario=<name>` loads a scenario |
| `scenarios/*.tsx` | A synthetic `window.nekko`, real views, a `window.integration` handle |
| `electron-main.cjs` | Hidden, non-focusable, off-screen window; scratch profile; non-local requests cancelled |
| `harness.ts` | `scenarioTest(name)`: one Electron per spec file, `scenario.resize()`, `shot(label)`, focus check, process-tree cleanup |

## Rules

- **Never touch the user's desktop.** Windows stay off every monitor, are shown
  inactive, and must never take focus (every test asserts it). No OS input:
  Playwright's input goes through CDP to the page.
- **Synthetic data only.** Scenarios never reach a host, daemon or the network.
- **Journeys, not features.** Add a `test.step` to the journey that owns the
  surface before you add a new spec. A new spec is for a new user journey.
- **Assert behaviour.** Prefer roles, labels and `data-*` hooks over CSS classes
  or source text.

## Adding a scenario

1. Add `scenarios/<name>.tsx`. It installs `window.nekko` and
   `window.integration`, then renders.
2. Register it in `fixture-app.tsx`.
3. Use it from a spec: `const test = scenarioTest('<name>', { width, height })`.

## Ported so far

| Journey | Replaces |
|---|---|
| `sidebar.e2e.ts` | `scripts/agent-sidebar-sandbox.cjs` (CI `capture` job) |
| `chat-finder.e2e.ts` | `scripts/chat-finder-{fixture,integration,sandbox}` |

The remaining harnesses are listed in TASKS.md ("Test suite trim and consolidated
end-to-end").

Before/after captures against a base revision (the old `NEKKO_TEST_REVISION`)
aren't supported yet. For PR evidence, run the suite on the base worktree and on
the head and compare the two reports.
