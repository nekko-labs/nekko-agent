---
title: Changelog page
area: brand
---

# Changelog page

## Intent and design

One public page, nekkoagent.com/changelog, lists the changes worth knowing in each release line and credits the people who shipped them. Requested by Philip on #2810: a scrollable page for what's new in each release, with credit for the work.

- **A quiet reading page**, like Status, Privacy and Beta: the 720px column, site tokens only, White and Dark, the look set before first paint. No cards, borders or tiles around a highlight: space and type separate them. No sticker button.
- **One section per release line** (MAJOR.MINOR), newest first, each with its own anchor (`/changelog#0.10`): the line, the month and year of its newest release, and a one-sentence intro. Jump links appear at the top once there are two or more lines.
- **Each highlight** has a title, one line of detail, then "Shipped by" with each author's avatar and GitHub login (linked to the profile) and the pull request number (linked to the pull request). No icons on this page: the app's Gentleface glyphs are embedded in the desktop renderer and are not copied by hand into the site.
- **Each section ends** with "See every change in 0.10 on GitHub", linking to the GitHub release for that line's newest tag.
- **History starts at 0.10 and goes forward.** Nothing older is backfilled; one line at the bottom, "Earlier releases on GitHub", links to the releases list.
- **Ways in:** the nav and footer of every site page that has them (home, Status, Privacy, Beta, Pricing; the download redirect has neither), `sitemap.xml`, `llms.txt`, and a short docs page, "What's new", that points here. The docs do not carry a second copy.

## Data and privacy boundaries

- **One highlights file, `docs/hub/whats-new.json`**, is the source for this page and, later, for the app's What's new sheet. Keyed by release line: `date` (ISO day of the newest release), `tag` (that release's tag), `intro`, and `highlights`, each with `title`, `detail`, `pr`, optional `icon`, and `authors` (GitHub logins of the pull request's author). It sits under `docs/` because the Docs site workflow and Vercel's ignore step already watch that folder, so an edit deploys the site with no new path to keep in step.
- Authors are the pull request's author as GitHub reports it, looked up when the entry is written, never guessed. Logins are validated against GitHub's login pattern; profile and pull request links are built from the login and number, so no string in the file becomes an arbitrary link.
- **The page is plain HTML written by the website build** (`scripts/build-docs.mjs`), generated at deploy and gitignored like the docs pages. It reads fully with JavaScript off and ships no script of its own.
- **Avatars are the ones the contributor wall already caches at deploy**, served from nekkoagent.com. The build writes the page with initials, then, once the contributor refresh has run, writes it again with each author's cached avatar. A visitor's browser never contacts GitHub. An author with no cached avatar, or a failed refresh, keeps initials; the name and links are always there. They follow the wall's rules ([contributor wall](github-contributor-wall.md)): public GitHub avatars, credit for contributed work, never committed. Removal requests go to hello@nekkoagent.com.
- The build fails on a highlight with no title, detail, pull request or author, on an invalid login, and on a line whose date or tag is malformed.

## Acceptance and status

Implemented in source; not deployed.

- `/changelog` shows 0.10 with five highlights, each with its real author and pull request link, the per-line GitHub link and the "Earlier releases" line.
- Node tests: the page is generated; every highlight has a title, a pull request and at least one author; anchors are unique; no page makes a third-party request; the highlights file matches its schema; the avatar pass uses only first-party `/contributors/` paths and keeps initials when one is missing.
- Headless Chrome checks at 1440px and 390px, White and Dark: no horizontal overflow, keyboard order follows the page, no third-party requests, readable with JavaScript off. Screenshots in the pull request. At 900px and below the quiet pages' top bar shows no links (as on Status); the footer carries the link there.

Planned, separate changes (#2810): the desktop sheet reads this file instead of its own copy; the sheet opens once after an update; the release workflow writes the file.
