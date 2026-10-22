---
title: "Noninteractive shell input and bounded stop cleanup"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Noninteractive shell input and bounded stop cleanup

Implemented: the TypeScript fallback closes Windows command stdin immediately, matching the Rust daemon's existing null stdin and Unix fallback's ignored stdin. Commands requiring interactive input receive EOF, not an indefinitely open input pipe. The existing 120-second execution deadline and turn cancellation request process-tree termination. The TypeScript fallback now also bounds the wait for close callbacks to five seconds after stop, preserving bounded partial stdout/stderr, removing its abort listener and timers, and settling exactly once even if pipes remain open or a close callback arrives late. This guarantees tool-result settlement after the execution deadline plus cleanup grace while the host event loop is responsive; it does not guarantee that every OS process was terminated. Approvals before process launch remain outside this execution deadline. No UI or permission change. Mocked Windows stalled-close tests and real Windows `date /t` and stdin-EOF commands pass; the reported screenshot's specific hang is not reproduced, and affected-session logs were outside the accessible workspace. Rust already implements closed stdin and five-second kill grace; no Rust change is needed. Packaged-app reproduction remains unverified.
