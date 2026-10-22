---
title: "Page recovery and startup appearance (2026-10-12)"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Page recovery and startup appearance (2026-10-12)

Settings and Model Server must show loading or a recoverable error instead of a blank page when the local service cannot answer. Settings uses the shared loaded preferences; a failed refresh preserves the last successful values, reports the problem, and offers Try again. Model-server polling preserves its last status during an outage and reports that it could not refresh. A rendering failure is contained to its page or section: navigation, neighbouring sections, and unrelated overlays remain usable. Retrying remounts the failed section. No fallback invents saved settings or a running server, changes credentials, downloads software, or sends diagnostic data remotely.

The initial loading/login UI resolves light or dark from the system preference before mounting. Fresh installs continue following system changes; an explicit theme remains authoritative. The shared desktop title bar uses the same pixel Nekko as Agents across every destination and retains the destination heading, version and native controls.

Implemented and checked with fresh Rust defaults, rejected/empty settings responses, rejected server status, retry recovery, a synthetic rendering failure, and matched hidden desktop/narrow captures in both themes. The friend's exact installed version, OS and original exception are unavailable; these checks verify the reproduced blank-page failure paths, not the cause of their service failure or a packaged-install upgrade. General async event-handler failures still need local handling; render boundaries do not intercept those.
