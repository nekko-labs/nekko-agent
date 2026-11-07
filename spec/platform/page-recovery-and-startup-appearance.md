---
title: "Page recovery and startup appearance (2026-10-12)"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Page recovery and startup appearance (2026-10-12)

Settings and Model Server must show loading or a recoverable error instead of a blank page when the local service cannot answer. Settings uses the shared loaded preferences; a failed refresh preserves the last successful values, reports the problem, and offers Try again. Model-server polling preserves its last status during an outage and reports that it could not refresh. A rendering failure is contained to its page or section: navigation, neighbouring sections, and unrelated overlays remain usable. Retrying remounts the failed section. No fallback invents saved settings or a running server, changes credentials, downloads software, or sends diagnostic data remotely.

**A slow engine start recovers by itself (issue #2067).** `[implemented 2026-11-07; unit tests and a real-app relaunch with every engine call failing for the first seconds; the desktop app's own launch unverified]` The engine can take longer to start than the first calls wait. The app keeps asking every 5 seconds until it answers, then shows the saved settings, the connected providers and the chats without being sent to another page. Reconnecting clears the "Could not load settings" notice, which shows once however often it retries. Windows on the Agents board are never closed because of this: the board compares its windows with the chat list only once that list has really loaded. Before, a failed first load closed every window, left the board blank, and the composer stayed disabled saying a model provider was needed.

The initial loading/login UI resolves light or dark from the system preference before mounting. Fresh installs continue following system changes; an explicit theme remains authoritative. The shared desktop title bar uses the same pixel Nekko as Agents across every destination and retains the destination heading, version and native controls.

Implemented and checked with fresh Rust defaults, rejected/empty settings responses, rejected server status, retry recovery, a synthetic rendering failure, and matched hidden desktop/narrow captures in both themes. The friend's exact installed version, OS and original exception are unavailable; these checks verify the reproduced blank-page failure paths, not the cause of their service failure or a packaged-install upgrade. General async event-handler failures still need local handling; render boundaries do not intercept those.
