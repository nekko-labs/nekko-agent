---
title: "Startup splash and window launch (2026-10-21)"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Startup splash and window launch (2026-10-21)

User intent: opening the app should feel branded and quick, never flash white, and land on the real app rather than a loading screen. Reloading should be quiet: no bright flash, and never a glimpse of a first-run screen the user is already past.

- The main window opens on a solid splash in the user's theme colour. The logo builds up from pixels on a beat (chunky, medium, fine, then the smooth mark), each step a faithful lower-resolution copy of the real logo. The logo is centred and a little under a tenth of the window's longer side.
- Once the app behind has loaded (settings, the provider list, and the transcripts of the open chats, waiting at most a second for those) and finished its first render, the logo zooms towards the viewer and the inside of the cat opens as a window onto the app, until the app fills the screen. If loading takes more than 6 seconds, the zoom runs anyway.
- The splash colour comes from the theme the user last applied, saved locally each time a theme is applied, because the splash shows before settings load. It is always a solid colour from that theme (its accent, or the theme's main colour when the accent is pale), never white, with a white or ink logo, whichever reads better. A first launch uses the website's lavender.
- The build starts only once the window is on screen, so it is never half-played when the window appears. Reduced motion skips the animation and fades the solid splash out. Screen windows on other displays show no splash.
- Reloading the page (Ctrl+R) does not replay the splash. The current page fades to a solid cover in the theme's own background colour (120ms) with a faint logo, the cover holds until the app behind has loaded as above (the same 6 second limit), then fades away (180ms). The cover matches the app's background, so it is never brighter than the app it covers. Screen windows show no cover. A reload in a browser tab, or one the app starts itself, has no fade in: the cover is simply there when the page starts.
- While providers are loading, the app does not know whether any are set up, so it shows neither the "Get started" banner nor the "Bring your first agent to life" welcome. A chat whose transcript is still loading shows no welcome at all. Those appear only once the load has finished and found nothing. Neither startup wait includes the model list, which can be a network call to the provider: only a setup that depends on a local model needs it to know.
- The main window comes to the front when it opens and reopens maximised if it was maximised when closed.
- Privacy: only the splash's colours (ground, logo, and the theme's background for the reload cover) are stored, in the renderer's local storage. Nothing is sent anywhere.

Status: implemented. Checked with the splash's own code at 1280×696 and 2560×1392 (frame captures and main-thread timing) and in the Windows dev app. The pixel layers are precomputed (`scripts/gen-splash-cells.mjs`) so nothing is rasterised at launch. The reload cover and the first-run gating were checked by reloading the real renderer entry against a stub bridge with slow providers, model lists and transcripts. Not yet checked: the Ctrl+R key handler in a final build, macOS and Linux, a packaged install, and every theme in the installed app.
