---
title: "Live link previews in chat"
area: chat
---

# Live link previews in chat

**Implemented in this change; automated renderer tests passed, visual inspection and packaged-app verification pending.** A web link in a chat reply has a Preview control next to it. Clicking it loads the live page in a compact inline frame inside that chat message. Nothing is fetched until the person clicks Preview. Closing it removes the frame. The original link still opens normally and the frame offers Open in browser pane, using the existing in-app browser.

The frame accepts only absolute HTTP(S) URLs already approved by the markdown link guard. It has a sandbox allowing scripts and forms but not same-origin access, and sends no referrer. A remote site can block embedding with CSP or X-Frame-Options; in that case use Open in browser pane. This is a live page, not a saved screenshot or a trusted execution environment: the website controls its own contents and can change or track visitors after they opt in. Preview buttons are not added to `mailto:` or unsafe schemes.

**GitHub pull request links** `[implemented 2026-11-04; renderer tests pass, packaged-app check pending]` render as a compact chip instead of an underlined link with a Preview button: GitHub's open, draft, merged or closed glyph in its state colour, then the link's own label (or `repo#123` for a bare URL). The state comes from the host's by-URL PR read (`pr:info`: gh first, the GitHub API with the connector token as fallback, cached for a minute and shared by every chip naming that PR); until it arrives, or if it cannot be read, the glyph is neutral. Clicking opens the PR in the external browser, and right-click offers the usual link actions. Every chat link, local file links included, shows the pointer cursor on hover. Planned: none; unverified: sites that forbid embedding, and interaction in a packaged desktop build.
