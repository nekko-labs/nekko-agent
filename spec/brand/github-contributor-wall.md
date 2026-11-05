---
title: GitHub contributor wall
area: brand
---

# GitHub contributor wall

## Intent and design

Thank the people building Nekko Agent in a clean, compact section at the bottom of the marketing homepage, after downloads and before the footer. Equal-size circular avatars form a centered, wrapping wall, not ranked team cards. Names appear on hover and keyboard focus. Each avatar links to its GitHub profile. A thank-you, full contributor-list link and contribution-guide link remain useful without JavaScript or when GitHub is unavailable.

Research: [Svelte's homepage](https://svelte.dev/) groups linked contributors in its closing community section, keeping recognition compact. [Vite's team page](https://vite.dev/team) uses large individual cards with roles and biographies. Adopt the compact Svelte-style pattern for the homepage, without copying code or assets. No invented team roles, counts, or people.

## Data and privacy boundaries

- The website build fetches every page of GitHub's repository contributors API for `nekko-labs/nekko-agent`, deduplicates usernames, and excludes accounts GitHub marks as bots. API ordering is retained; avatar sizes are equal.
- GitHub's list reflects attributed commits, not everyone who has filed an issue, tested a build, or contributed outside GitHub. The copy does not claim otherwise. GitHub can cache this endpoint.
- Data and avatars refresh with each site deployment, not on each visit. There is no new scheduled deployment or runtime backend.
- All browser requests stay first-party. Only the build contacts GitHub. An optional existing `GITHUB_TOKEN` authenticates API calls, never avatar requests, and is never published.
- Avatars must come from GitHub's avatar host, use a supported raster format, and remain below the build's size limit. They are generated, never committed. Philip explicitly approved using public GitHub avatars for this contributor-credit section; no open-source license over profile images is assumed. Removal requests go to hello@nekkoagent.com.
- If an avatar fails, retain the person with an initials icon. If the list cannot refresh, publish no stale list or inaccurate count; show links to GitHub and the contribution guide. No client-side API retries or third-party fallback requests.

## Acceptance and status

Implemented in source; not yet verified on production. Focused Node tests verify pagination, duplicate/bot filtering, malformed responses and URL rejection, API and avatar failures. Isolated Chromium checks at 1440px and 390px verify no horizontal overflow, keyboard profile names and tab order, no third-party page-load requests, initials after an image error, API-unavailable and no-JavaScript fallbacks, and wrapping with 150 test contributors. Matching desktop/mobile before/after PNGs were captured. Pixel inspection remains blocked: the browser screenshot tool timed out and native capture returned UnknownVizError. The PR must remain draft until visual inspection is completed. Evidence and test results belong in the linked PR. No new animation is introduced.
