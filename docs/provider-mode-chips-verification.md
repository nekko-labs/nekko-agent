# Provider billing-mode chips (#2356)

## Behavior

Implemented in the shared desktop/web renderer. Provider-card headers distinguish **Subscription** from **API**, independently of the connection-health badge. Claude Code uses its provider-scoped `claude:codeStatus` response, not a saved label or `auth` flag: a logged-in `subscription` reports Subscription; `api_key` and `cloud` report API. Pending, unknown, missing and signed-out CLI statuses report neither. The source line and chip share one read and refresh on window focus. Disabled Claude Code cards do not probe the CLI.

ChatGPT retains Subscription, including older cards without an auth flag. API connections (Anthropic, OpenAI, OpenRouter, Bedrock, Vertex, Foundry and compatible endpoints) show API. OpenRouter's sign-in mints a metered API key, not a subscription. Local server kinds and disabled cards get neither chip; retired Anthropic plan cards keep their migration UI without a misleading billing label. No provider execution, credential, wire or pricing behavior changes.

## Verification

- Desktop typecheck after building shared/profile: passed.
- Built desktop suite: **3,463 tests across 372 files passed**. The first pre-build run failed seven bundle tests because their expected build outputs did not exist; building the desktop resolved those setup failures.
- 45 focused renderer tests across billing badges, provider setup, Claude setup/status and Models workspace: passed (21 new billing-mode cases).
- Actual hidden Electron renderer fixture: 1100, 360 (folded/narrow), 768 (unfolded/tablet) CSS-pixel widths, dark theme, identical synthetic data and routes before/after. 24 baseline and 42 after DOM/geometry/interaction assertions passed; zero renderer errors. Mode refresh switches Subscription → API → no chip when signed out. Native capturePage frames use stayHidden/stayAwake, an isolated profile, an off-screen non-focusable window and blocked external requests. The user's running app was not touched.
- Captures: `.shots/layout-evidence/{before,after}/{subscriptions,api,code,local}-{1100,360,768}.png`; reports live beside captures. Media is published to the shared `pr-media` pre-release by the repository uploader, never committed to the product branch.
- Pixel inspection status and published links are recorded in the PR description. Capture success alone is not visual approval.

### Reproduction (Windows cmd)

```bat
set NEKKO_LAYOUT_FIXTURE=provider-mode-chips-fixture.tsx
set NEKKO_LAYOUT_SANDBOX=provider-mode-chips-sandbox.cjs
set NEKKO_TEST_LABEL=after
set NEKKO_EXPECT_MODE_CHIPS=1
node apps/desktop/scripts/layout-evidence-integration.cjs
```

Capture the unchanged revision before editing, or supply its source using `NEKKO_TEST_SOURCE` for matched baseline frames. Do not set `NEKKO_EXPECT_MODE_CHIPS` for the baseline.

## Limitations

Synthetic status/model-list responses, not an authenticated provider exchange. No paid inference, credentials, packaged builds, native iOS/Android or non-Windows desktops were exercised. Narrow and unfolded widths are capability-based responsive checks, not claims of hardware-specific foldable support. No motion change, so still frames suffice.
