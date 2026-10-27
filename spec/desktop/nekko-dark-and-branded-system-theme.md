---
title: "Nekko Dark and the branded System theme (desktop)"
area: desktop
---

# Nekko Dark and the branded System theme (desktop)

User intent: the app's dark look should match the website's default Dark look, and anyone who has not picked a theme should get the branded looks instead of the plain light and dark ones.

## Nekko Dark

- A preset in Settings > Theme, directly after Lavender. It uses the website's Dark colours: the `#0d0b18` indigo-black ground, `#181430` and `#1d1a36` surfaces, white ink, and the lavender `#c4b9ff` and aqua `#8ae4f2` accents. The lavender is too light for white button text, so primary buttons use the dark ground colour for their text.
- **Glow background**: the window's field (the background around and between panels) paints the website's Dark body background, the same six radial lavender and aqua gradients at the same colours and positions over `#0d0b18`. The title bar and the native window buttons on Windows and Linux are see-through, so the glow runs up behind them. Panels stay solid, so text contrast is the same as without the glow.
- The glow is static: no animation, transition or timer. Idle CPU and GPU use were measured unchanged.
- The sidebar rail is filled with the raised `#1d1a36` surface and given a faint lavender edge, because darkening the near-black ground made it invisible.
- The pixel-dot wave stays limited to empty agent windows, and the Background animation setting is unchanged.

## The branded System theme

- **System** follows the computer's light or dark mode with the branded looks: Nekko Dark in dark mode, Lilac in light mode. It switches live when the computer changes mode.
- Its tile previews both looks.
- A profile with no theme or preset saved (a fresh profile) is treated exactly like System, and the System tile shows as selected for it. A profile that saved System before this change gets the branded looks too.
- An accent the user changed from System's shipped accents still overrides the branded look.

## Boundaries

- Anyone who explicitly picked another preset keeps it unchanged, as does a profile that saved only a base light or dark mode with no preset.
- The glow, see-through title bar and rail colours apply only to Nekko Dark; no other theme changes.

## Status

- Implemented on the desktop app and the Local Web UI renderer, with tests for the resolution, the fresh-profile default, contrast, and the glow matching the website's stylesheet.
- Unverified: whether the native window buttons on Windows show the glow through them (a transparent Window Controls Overlay colour). The iOS app knows the Nekko Dark preset id but has no glow.
