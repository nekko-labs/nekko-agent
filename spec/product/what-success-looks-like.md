---
title: "What Success Looks Like"
area: product
split-from: SPEC.md (2026-10-22)
---

# What Success Looks Like

- **Offline PC control target (planned):** on a supported machine, a non-expert can review and approve one setup plan, complete required OS permission prompts, and use the selected intent/speech stack for approved local actions with external network access blocked. Model choices meet verified whole-stack minimum requirements, sensitive actions require confirmation, and stop/revocation reliably prevents subsequent actions. Unsupported hardware or capabilities are explained rather than hidden by cloud fallback.

- **"Connect + use a local model" just works**: one-click local setup, and the model can actually read/edit/run in a real codebase end-to-end (verified repeatedly against a live LM Studio gemma reasoning model: streaming reasoning, single + multi-step tool loops, index-grounded context).
- **The unique features land**: users can *see* what the model is given (Context Inspector) and trust it on risky commands (guardrails), the two differentiators from the original ask.
- **Same app everywhere**: desktop, one-command web, Docker, and (paid) hosted, with a byte-identical UI.
- **Polished enough to stand next to Zed/Cursor/Warp**: whitespace, themes, speed, and a charming mascot.
- **Shipped and installable**: public MIT repo with downloadable installers for win/mac/linux, auto-updates, and a marketing site with downloads. macOS builds are signed with a Nekko Labs Developer ID certificate and notarized by Apple, so a download installs with no Gatekeeper workaround; Windows signing (SignPath Foundation) is still pending.
