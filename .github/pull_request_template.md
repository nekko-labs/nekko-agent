## What & why

<!-- What does this change and why? Link any related issue. -->

## Visual evidence

<!--
  Required for anything that changes how the UI looks. Fill the table with before/after
  screenshots (same route, viewport, and theme). If the change is animation, transition,
  gesture, scroll, or timing related, also attach a short screen recording. If nothing
  rendered changed, replace this section with "no visual change".
-->

| Before | After |
| --- | --- |
|  |  |

## Checklist

- [ ] UI change: before/after screenshots attached (plus a short video if animation changed), or "no visual change"
- [ ] `npm run build` passes (nekkod, then shared, profile, the CLI and desktop)
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Added/updated tests for engine changes (`crates/`, `cargo test --workspace`)
- [ ] For provider changes: verified against a real server (a chat through the CLI on this checkout's nekkod)
