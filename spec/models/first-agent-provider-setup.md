---
title: "First-agent provider setup"
area: models
split-from: SPEC.md (2026-10-22)
---

# First-agent provider setup

Implemented in the desktop renderer; desktop visual and live authentication verification remain pending. Adding a chat refreshes provider state and routes to **Model Providers** instead of creating an empty chat when no enabled provider is configured. The automatically registered Nekko Agent engine alone is not sufficient: it must have a selected or available model. Existing empty chats show an illustrated **Set up my first agent** entry instead of an empty model list. A configured but unreachable external provider remains a connection-recovery case, not a first-run reset.

The first-provider page is a short **Choose → Connect → Start** flow with an illustrated Nekko, large responsive provider buttons, bundled brand icons, plain-language account/cost descriptions, a back action, and an explicit continuation to the agent/model choice after saving. Users can instead open Model Server for the managed local path. The same large buttons replace the generic add-provider chips for existing users. Connection name and endpoint live under a disclosure; API-key and server connections are tested before saving, with failures kept on the form. Cancel never advances to success. Keyboard focus and selected states are visible; brief entry/hover motion respects reduced-motion preferences.

Privacy boundaries: icons load locally; selection alone never signs in, installs models, or saves credentials. Existing host-side subscription authentication and credential handling remain unchanged. Online-provider disclosure explains that sent messages go to that provider and paid plans/usage may apply. Acceptance verification must cover no providers, disabled providers, an empty engine, a model-ready engine, existing providers, cancellation, connection failure, successful continuation, narrow/wide layouts, both themes, and reduced motion. Automated readiness/routing and card-markup tests are included; full interactive wizard, OAuth, and desktop motion evidence are not yet verified.
