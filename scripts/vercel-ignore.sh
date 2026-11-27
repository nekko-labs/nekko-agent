#!/bin/sh
# Vercel's Ignored Build Step (vercel.json `ignoreCommand`): exit 0 skips the
# build, anything else builds. Vercel only serves apps/website, so a commit that
# leaves the site's inputs alone gets no deployment. The paths are the Docs site
# workflow's (scripts/build-docs.test.mjs keeps them in step) plus the site, its
# own config, and the desktop sources the design system page reads its tokens
# and marks from (scripts/build-design-system.mjs).
#
# VERCEL_GIT_PREVIOUS_SHA is the branch's last successful deployment, so commits
# whose builds were skipped still count. Vercel clones only the last 10 commits,
# though, and a new branch has no previous deployment. Then production builds
# (main must never miss a site change) and a preview compares the last commit.
base=${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  [ "$VERCEL_ENV" = production ] && exit 1
  base=HEAD^
fi
git diff --quiet "$base" HEAD -- \
  apps/website \
  docs \
  ASSETS.md \
  CONTRIBUTING.md \
  scripts/build-docs.mjs \
  scripts/site-languages \
  api/site-country.mjs \
  scripts/build-contributors.mjs \
  scripts/build-design-system.mjs \
  scripts/design-system \
  apps/desktop/src/renderer/styles.css \
  apps/desktop/src/renderer/gentleface-icons.tsx \
  apps/desktop/src/renderer/icons.tsx \
  apps/desktop/src/renderer/components/WallMascot.tsx \
  scripts/vercel-ignore.sh \
  vercel.json \
  package.json \
  package-lock.json
