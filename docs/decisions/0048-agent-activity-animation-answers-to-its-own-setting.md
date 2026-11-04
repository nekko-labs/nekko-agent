---
status: accepted
date: 2026-11-04
---

# 0048. The agent activity animation answers to its own setting

## Context

The Agents panel's live groups show a small Nekko animation beside their name.
The app honors the system's reduced-motion preference for all motion: one rule
in `styles.css` forces every animation to a single 0.01ms run. On a Windows
machine with Animation effects off, that left the animation frozen on one frame,
and the person who asked for it wanted it to move regardless of that system
setting, with a switch of its own in the app.

## Decision

**Settings > Accessibility > Agent activity animation** alone decides whether
this animation plays. It is on unless turned off. The animation is exempt from
the app-wide reduced-motion rule, and only this animation: every other animation
still follows the system. It still pauses with all other motion while the app
is not active (`html[data-app-inactive]`).

## Alternatives

- **Follow the system preference, as everything else does.** Rejected at the
  owner's request: the animation is how the panel says work is in progress, and
  Windows turns Animation effects off for reasons other than motion sensitivity.
- **One switch for all app animation.** Larger than the need, and it would
  override the system preference everywhere rather than in one small place.

## Consequences

Someone who relies on the system preference to avoid motion sees this animation
until they turn the setting off. It is 24 by 16 pixels and steps a few frames a
second, which limits the exposure but does not remove it. A person who needs this
to be automatic is a reason to revisit the decision, by defaulting the setting
from the system preference. Spec: [Agent panel view options](../../spec/agents/agent-panel-view-options.md).
