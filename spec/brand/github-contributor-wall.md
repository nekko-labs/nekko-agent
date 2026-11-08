---
title: GitHub contributor wall
area: brand
---

# GitHub contributor wall

## Intent and design

Thank the people building Nekko Agent in a clean, compact section at the bottom of the marketing homepage, after downloads and before the footer. Equal-size circular avatars form a centered, wrapping wall, not ranked team cards. Nekko Labs team members (the `nekko-labs` GitHub org members, kept as a list in the build script) always come first and wear a glowing brand-pink ring; their profile label also says they are on the Nekko Labs team. Names appear on hover and keyboard focus. Mobile tooltips size to their names up to 88px, wrapping long GitHub logins without collapsing short names into a letter-by-letter column. Each avatar links to its GitHub profile. The lede reads "Our Nekko Labs team and community is amazing! Huge thank you to the people sharing their time, ideas and code to make Nekko Agent yours.", with "Nekko Labs" linking to nekkolabs.com and "team" to its team section (nekkolabs.com/#team). Below the wall, the status line shows only the contributor count. Below the wall, a "Check out the team" link (to the repo's GitHub contributors tab) sits vertically aligned beside a primary "Make a contribution!" button (to the contribution guide). The thank-you and both links remain useful without JavaScript or when GitHub is unavailable.

Research: [Svelte's homepage](https://svelte.dev/) groups linked contributors in its closing community section, keeping recognition compact. [Vite's team page](https://vite.dev/team) uses large individual cards with roles and biographies. Adopt the compact Svelte-style pattern for the homepage, without copying code or assets. No invented team roles, counts, or people.

## Data and privacy boundaries

- The website build fetches every page of GitHub's repository contributors API for `nekko-labs/nekko-agent`, deduplicates usernames, and excludes accounts GitHub marks as bots. Team members move to the front; API ordering is otherwise retained; avatar sizes are equal.
- GitHub's list reflects attributed commits, not everyone who has filed an issue, tested a build, or contributed outside GitHub. The copy does not claim otherwise. GitHub can cache this endpoint.
- Data and avatars refresh with each site deployment, not on each visit. There is no new scheduled deployment or runtime backend.
- All browser requests stay first-party. Only the build contacts GitHub. An optional existing `GITHUB_TOKEN` authenticates API calls, never avatar requests, and is never published.
- Avatars must come from GitHub's avatar host, use a supported raster format, and remain below the build's size limit. They are generated, never committed. Philip explicitly approved using public GitHub avatars for this contributor-credit section; no open-source license over profile images is assumed. Removal requests go to hello@nekkoagent.com.
- If an avatar fails, retain the person with an initials icon. If the list cannot refresh, publish no stale list or inaccurate count; show links to GitHub and the contribution guide. No client-side API retries or third-party fallback requests.

## Acceptance and status

Implemented in source; not yet verified on production. Focused Node tests verify pagination, duplicate/bot filtering, malformed responses and URL rejection, API and avatar failures. Isolated Chromium checks at 1440px and 390px verify no horizontal overflow, keyboard profile names and tab order, no third-party page-load requests, initials after an image error, API-unavailable and no-JavaScript fallbacks, and wrapping with 150 test contributors. Matching desktop/mobile before/after PNGs and focus captures were inspected through an isolated evidence browser. Inspection found the mobile name tooltip collapsing to one character per line; the corrected content-sized tooltip has a focused source regression and real headless Chromium checks at 320px, 390px and 1440px, including long-name viewport bounds. Matching fix before/after screenshots were also inspected. Production deployment remains unverified. Evidence and test results belong in the linked PR. No new animation is introduced.
