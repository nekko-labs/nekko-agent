---
title: "Startup splash and window launch (2026-10-21)"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Startup splash and window launch (2026-10-21)

User intent: opening the app should feel branded and quick, never flash white, and land on the real app rather than a loading screen.

- The main window opens on a solid splash in the user's theme colour. The logo builds up from pixels on a beat (chunky, medium, fine, then the smooth mark), each step a faithful lower-resolution copy of the real logo. The logo is centred and a little under a tenth of the window's longer side.
- Once the app behind has loaded and finished its first render, the logo zooms towards the viewer and the inside of the cat opens as a window onto the app, until the app fills the screen. If loading takes more than 6 seconds, the zoom runs anyway.
- The splash colour comes from the theme the user last applied, saved locally each time a theme is applied, because the splash shows before settings load. It is always a solid colour from that theme (its accent, or the theme's main colour when the accent is pale), never white, with a white or ink logo, whichever reads better. A first launch uses the website's lavender.
- The build starts only once the window is on screen, so it is never half-played when the window appears. Reduced motion skips the animation and fades the solid splash out. Screen windows on other displays show no splash. Reloading the page (Ctrl+R) plays it again.
- The main window comes to the front when it opens and reopens maximised if it was maximised when closed.
- Privacy: only the two splash colours are stored, in the renderer's local storage. Nothing is sent anywhere.

Status: implemented. Checked with the splash's own code at 1280×696 and 2560×1392 (frame captures and main-thread timing) and in the Windows dev app. The pixel layers are precomputed (`scripts/gen-splash-cells.mjs`) so nothing is rasterised at launch. Not yet checked: macOS and Linux, a packaged install, and every theme in the installed app.
