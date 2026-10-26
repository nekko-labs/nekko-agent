---
title: "Empty wall opens the new-chat screen; glass prism composer (2026-10-18)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Empty wall opens the new-chat screen; glass prism composer (2026-10-18)

`[implemented; unit-tested; verified in an isolated hidden renderer (12 checks, dark and light, 1400px) with matched before/after captures; packaged app, narrow widths, multi-screen and macOS not checked]`

- **No more empty wall.** When the Agents wall has no windows (first launch with a provider set up, or the last window closed or completed), the main window switches to **Focused** and shows the new-chat screen ("What should we work on?") instead of "The wall is empty". It reuses the newest untouched chat (no messages, nothing queued, not completed, not an image, sub-agent, automation or training chat) before creating one, so emptying the wall repeatedly never piles up blank chats. It waits for the chat lists to load, does nothing while a completed chat is being read, does nothing on a second screen's window (those may be empty on purpose), and does nothing until a provider is set up (the setup path still applies). A failure is toasted once and not retried until the wall has had a window again. The "The wall is empty" placeholder remains only for those cases.
- **Glass prism composer.** The round radial halo behind the clean-start composer is gone. The page gets a full-surface, static top-to-bottom gradient from dark teal through muted teal to gold, not separate corner orbs. A low-opacity, fixed-seed monochrome SVG noise layer sits over the gradient to reduce banding; it never intercepts pointer input, covers text, animates or fetches a remote resource. The composer itself is frosted glass: a translucent tint over a blur of that light, a top highlight, and a violet-cyan-teal-amber-pink prism hairline as its only edge, brighter while it has focus. Light themes use a whiter glass. `prefers-reduced-transparency` falls back to the solid window colour. The gradient and grain stay static. For themes with a pixel wave, that optional animation appears only inside the visible new-chat surface and unmounts when the chat starts or is parked. Settings > Appearance and reduced-motion behavior still apply. There is no app-wide pixel-wave canvas.
- Renderer-only: no new settings keys, host calls, permissions or network use. A new chat is created only through the existing create-session path.

## Full static gradient (issue #1108)

Implemented. Matching unchanged-base and working-tree Electron window captures in default dark at 1440×900 and 900×900 were inspected. The earlier full-surface diagonal gradient and fixed-seed grain leave the glass composer and its prism edge intact. Automated renderer checks confirm the linear gradient, embedded SVG grain, no grain animation, pointer pass-through, visible composer bounds and successful typing. The sandbox is hidden, off-screen, non-focusable, network-blocked and uses a separate profile. The shared full-App fixture emits the same unrelated missing app-info/list-data warnings on base and head. Other themes, Windows/Linux and packaged rendering are not visually verified. Reproduce with `NEKKO_LAYOUT_SANDBOX=new-chat-gradient-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs`; point `NEKKO_TEST_SOURCE` at an unchanged archive for the baseline.

## Centered greeting Nekko and rotating questions

`[implemented; focused tests and isolated renderer checks at 1280px and 460px; matched screenshots inspected; packaged desktop and physical trackpad not checked]`

- The new-chat greeting centers Nekko immediately to the left of the question above the composer. The pixel head and paws reuse Travis's website beta-signup design (PR #763), without a separate illustrated ledge. The eyes follow this composer's text insertion caret during typing and selection movement, with a bounded glance inside the face. Model Providers is unchanged.
- Ten bundled welcoming questions rotate every eight seconds while the composer is empty and visible. Draft text or attachments pause rotation; hidden documents and reduced-motion preferences disable automatic rotation. Copy changes are instant, without animated transitions or live-region announcements. The heading reserves room for wrapped questions so the composer does not jump.
- The decorative, non-focusable SVG inherits theme colors. Caret updates are coalesced per animation frame and scoped to this composer section; listeners and timers are removed on unmount. No model calls, network access, permissions, settings or persisted user data are added.
- Acceptance: mascot stays beside the readable question without clipping at desktop and narrow widths; composing and caret-following still work; questions rotate only while idle. Existing clean-start visibility rules remain unchanged, so transcript views do not gain artwork.
- Verification uses real ChatPane components with a synthetic bridge in an isolated profile, blocked networking and a hidden, non-focusable Electron window. Evidence covers renderer pixels, not OS chrome or native phone apps.

## Borderless new-chat frost (issue #1152)

Implemented candidate, superseding the opaque full-surface gradient and prism composer edge above. In Focus, an untouched new-chat agent window uses a translucent window tint with 24px backdrop blur and a faint translucent teal-to-gold wash plus fixed grain. The composer keeps its translucent tint and diffuse shadow, but has no hard prism outline, top hairline or focus outline decoration. Normal transcript windows retain their existing opaque surface. The window and composer both fall back to solid surfaces with no blur for `prefers-reduced-transparency`.

Acceptance: frost applies only while `data-clean-start` is present; no decorative outline appears when typing; the six budget durations remain visible beside it at the default dock width; typing and range selection work. Renderer-only, with no new settings, host calls, remote assets or permissions. Verified in a network-blocked, isolated-profile, hidden and non-focusable Electron fixture at desktop and narrow widths, with matched before/after evidence. OS-level transparency, packaged builds, other themes and non-macOS platforms have not been visually checked.
## Menu, tab and background follow-up (issue #1147)

Implemented; 53 focused unit tests and isolated Electron interaction checks pass. Matched before/after captures at 1440px, 900px and 460px plus motion evidence were inspected. Context menus and the agent-panel view submenus use neutral light or dark surfaces regardless of a preset's page tint. Hovered, keyboard-focused and selected menu rows use the current accent and its contrasting text colour. Switching to a chat updates the Agents panel highlight, expands its containing group if collapsed and scrolls that row into view without moving keyboard focus or changing the panel's grouping/filter settings. Hidden automation filters remain respected.

Acceptance: neutral menus remain legible in vivid page themes; the selected chat is visible even in a long panel; the background gradient runs vertically from dark teal to gold; pixel waves exist only inside a visible clean-start chat, never in existing chats or the app background. No new settings, network access, permissions or host mutations are introduced. Verification uses a synthetic full-App bridge in a hidden, non-focusable Electron window with a disposable profile and blocked network. Packaged and non-macOS desktop verification remain untested.

Integration with #1150 preserves its vertical teal-to-gold colour direction and new-chat-only pixel waves, with translucent gradient stops for the frost treatment. Updated merged-base renderer evidence covers this combined appearance.

## Slow color cycle and readable controls (issue #1178)

Implemented, superseding the static-gradient description above. The translucent new-chat wash continuously interpolates teal/gold, violet/rose, blue/mint and rose/amber palettes over a 120-second loop. Only registered CSS color stops animate; grain remains static and the animation stays scoped to an untouched new chat. Reduced motion holds the original palette still; the existing inactive-app policy pauses decorative animation. No remote assets, canvas loop or per-frame React updates are added.

The model and effort controls no longer dim as a group. They use an opaque theme surface, readable foreground labels and visible borders; effort has its own complete rounded border rather than a missing left edge. Controls can wrap on narrow widths. The shared Agents workspace loses 4px of top padding and moves up another 1px, lifting the agent windows and both side panels together by 5px without changing their internal gutters.

Verified: 120-second CSS duration, interpolated intermediate stops and matching loop endpoints, reduced-motion static behavior, matched desktop/narrow hidden Electron captures. The GIF samples the full cycle at 10x speed for review, not real-time playback. Other themes, packaged builds and Windows/Linux have not been visually checked.
