---
title: What's new page
area: brand
---

# What's new page

## Intent and design

One public page, nekkoagent.com/whatsnew, lists the changes worth knowing in each release line and credits the people who shipped them. Requested by Philip on #2810: a scrollable page for what's new in each release, with credit for the work.

- **A reading page in the home page's voice** (Kai, 2026-11-18: "I want to be on theme"): the 720px column of Status, Privacy and Beta, over the home page's dot wave, with its type: a heavy, tight title, the LED face (Handjet) for each release heading, and retro mono (Space Mono) for dates and the rail. Highlight titles and text stay in Inter Tight. Site tokens only, White and Dark, the look set before first paint. No cards, borders or tiles around a highlight: space and type separate them. No sticker button.
- **The dot wave is the home page's own**, one script (`apps/website/pixelwave.js`) both pages load. It follows the look, stops in a hidden tab and holds still under reduced motion. It is decorative and absent without JavaScript.
- **One section per release line** (MAJOR.MINOR), newest first, each with its own anchor (`/whatsnew#0.10`): the line, the month and year of its newest release, and a one-sentence intro.
- **A release rail** lists every release under its year, newest first, as month and line ("November 0.10"), each a link to its section. At 1180px and wider it sits left of the column and stays in view, and the release being read is marked as the page scrolls. Narrower, it is a row of links under the lede, and is hidden while there is only one release. Without JavaScript the links work and the mark stays on the newest.
- **Each highlight** has a title, one line of detail, then a credit line that leads with each author's avatar (28px), followed by "Shipped by", each GitHub login (linked to the profile) and the pull request number (linked to the pull request). No icons on this page: the app's Gentleface glyphs are embedded in the desktop renderer and are not copied by hand into the site.
- **Highlights sit in two columns** from 900px wide, one below.
- **Everyone who shipped the release** is named under its highlights (Kai, 2026-11-18: "so we ensure everyone gets proper recognition"): every person who merged a pull request in that line, avatar and GitHub login, linked to the profile. The order is shuffled on every build, so no one is always first. Bots are left out. A release has hundreds of pull requests, so they are not listed one by one; the link below goes to the full list.
- **Each section ends** with "See every change in 0.10 on GitHub", linking to the GitHub release for that line's newest tag.
- **History starts at 0.7 (September 2026)**, the first release under the Nekko name, so the page shows a few months of releases from the start (Kai, 2026-11-18; this replaces the earlier "start at 0.10, no backfill"). Earlier releases shipped as Kotrain and are not listed; one line at the bottom, "Earlier releases on GitHub", links to the releases list.
- **Ways in:** the nav and footer of every site page that has them (home, Status, Privacy, Beta, Pricing; the download redirect has neither), `sitemap.xml`, `llms.txt`, and a short docs page, "What's new", that points here. The docs do not carry a second copy.

## Data and privacy boundaries

- **One highlights file, `docs/hub/whats-new.json`**, is the source for this page and, later, for the app's What's new sheet. Keyed by release line: `date` (ISO day of the newest release), `tag` (that release's tag), `intro`, and `highlights`, each with `title`, `detail`, `pr`, optional `icon`, and `authors` (GitHub logins of the pull request's author); and per line `contributors`, the logins of everyone who merged a pull request in it, taken from the line's GitHub release notes when the entry is written. It sits under `docs/` because the Docs site workflow and Vercel's ignore step already watch that folder, so an edit deploys the site with no new path to keep in step.
- Authors are the pull request's author as GitHub reports it, looked up when the entry is written, never guessed. Logins are validated against GitHub's login pattern; profile and pull request links are built from the login and number, so no string in the file becomes an arbitrary link.
- **The page is plain HTML written by the website build** (`scripts/build-docs.mjs`), generated at deploy and gitignored like the docs pages. It reads fully with JavaScript off. Its two scripts only decorate: the dot wave, and the mark on the rail.
- **Avatars are the ones the contributor wall already caches at deploy**, served from nekkoagent.com. The build writes the page with initials, then, once the contributor refresh has run, writes it again with each author's cached avatar. A visitor's browser never contacts GitHub. An author with no cached avatar, or a failed refresh, keeps initials; the name and links are always there. They follow the wall's rules ([contributor wall](github-contributor-wall.md)): public GitHub avatars, credit for contributed work, never committed. Removal requests go to hello@nekkoagent.com.
- The build fails on a highlight with no title, detail, pull request or author, on an invalid login, and on a line whose date or tag is malformed, or whose contributors are missing, repeated or do not include a highlight's author.

## Acceptance and status

Implemented in source; not deployed.

- `/whatsnew` shows 0.10, 0.9, 0.8 and 0.7, each highlight with its real author and pull request link, the per-line GitHub link, and the "Earlier releases" line at the bottom.
- Node tests: the page is generated; every highlight has a title, a pull request and at least one author; anchors are unique; no page makes a third-party request; the highlights file matches its schema; the avatar pass uses only first-party `/contributors/` paths and keeps initials when one is missing; the rail lists every release under its year with one marked; each credit leads with the avatars; every release names everyone who shipped it, in an order set by the build's shuffle; highlights take two columns from 900px; the page and the home page load the one dot-wave script; the title, release heading, dates and rail use the home page's faces.
- Headless Chrome checks at 1440px and 390px, White and Dark: no horizontal overflow, keyboard order follows the page, no third-party requests, readable with JavaScript off. Screenshots in the pull request. At 900px and below the quiet pages' top bar shows no links (as on Status); the footer carries the link there.

Planned, separate changes (#2810): the desktop sheet reads this file instead of its own copy; the sheet opens once after an update; the release workflow writes the file.
