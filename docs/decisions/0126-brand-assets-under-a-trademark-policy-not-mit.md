---
status: accepted
date: 2026-11-28
---

# 0126. License the brand pack under our own trademark policy, not MIT or Creative Commons

## Context

We want people to use our logo, app icon and Nekko the mascot when they write about Nekko Agent (#3605). The repository is MIT licensed, and the files that draw the marks sit inside it, so nothing said whether the marks themselves were free to reuse, recolour or put on another product. MIT grants copyright permissions only; it says nothing about trademarks, and a fork could plausibly ship under our name and icon. The mascot rule in [the colour palette](../../spec/brand/colour-palette.md) already forbids changing Nekko without Philip's approval.

## Options considered

1. **Leave them under MIT.** Simplest. But MIT permits modification and any use, which contradicts the mascot rule, and invites forks that look like us.
2. **Creative Commons BY-ND 4.0 for the artwork, plus a trademark policy.** A license people already know; no-derivatives matches "don't change it", and CC 4.0 already excludes trademark rights. But it is irrevocable, it allows any commercial use of the unchanged files (merchandise included), and the policy would still be needed for everything that matters.
3. **Our own trademark policy with a limited, revocable license for the pack** (what GitHub, Docker, Mozilla and most companies do). Says plainly what is fine, what needs asking and what is never allowed, in one place. Not a standard license, so readers have to read it.

## Decision

Option 3. The brand assets are owned by Nekko Labs and excluded from the MIT grant; `TRADEMARKS.md` is the policy and contains the brand pack license, and `apps/website/brand/LICENSE.md` is its short form in the zip. Use to refer to us is free and needs no asking; changing the assets, merchandise, advertising, endorsement and new depictions of Nekko need permission; using them as another product's identity never. Forks may use the code under MIT but must ship under their own name and icon.

## Consequences

- Writers and community projects get clear, permission-free terms for the common case, and we keep control of the mascot and of anything commercial.
- We can withdraw permission for a bad use, which a CC license would not allow.
- Earlier commits published the same artwork in an MIT repository without saying the marks were excluded. The copyright license on those copies cannot be taken back, but MIT never granted trademark rights, so using our names or marks to pass something off as ours was never permitted.
- Someone has to answer hello@nekkoagent.com about permissions. If requests pile up for one kind of use, add it to "Fine without asking".
- The terms are not lawyer-reviewed yet; a review may change wording, not the shape of the decision.
