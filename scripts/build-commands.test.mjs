import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('default build builds and stages nekkod before building the app', () => {
  assert.equal(pkg.scripts.build, 'npm run build:nekkod && npm run build:app');
  assert.equal(pkg.scripts['build:nekkod'], 'node apps/desktop/scripts/stage-daemon.mjs');
  assert.match(pkg.scripts['build:app'], /build:core/);
  // build:core is shared and profile; nothing builds the deleted TS engine.
  assert.doesNotMatch(pkg.scripts['build:app'], /@nekko-agent\/(host|core)\b/);
  assert.match(pkg.scripts['build:app'], /build:app --workspace=apps\/cli/);
  assert.match(pkg.scripts['build:app'], /@nekko-agent\/desktop/);
  assert.doesNotMatch(pkg.scripts['build:app'], /cargo|stage-daemon|build:nekkod/);
});

test('dev builds before starting the desktop development server', () => {
  // Dependencies are installed first, so a pull that changed package.json or
  // the lockfile never launches against missing or stale modules. --no-save
  // keeps that install from rewriting package-lock.json: npm versions disagree
  // on its metadata, so every launch left a diff. Change the lock deliberately.
  assert.equal(pkg.scripts.dev, 'npm install --no-save --no-audit --no-fund && npm run build:dev && npm run dev -w @nekko-agent/desktop');
  // The daemon and every workspace the app imports are rebuilt, so dev never
  // runs stale output; the daemon uses the fast dev-daemon profile.
  assert.match(pkg.scripts['build:dev'], /^node apps\/desktop\/scripts\/stage-daemon\.mjs --dev && /);
  assert.match(pkg.scripts['build:dev'], /build:core/);
  assert.doesNotMatch(pkg.scripts['build:dev'], /@nekko-agent\/(host|core)\b/);
  assert.match(pkg.scripts['build:dev'], /build:app --workspace=apps\/cli/);
  // electron-vite dev bundles the desktop app itself; a production build first is wasted.
  assert.doesNotMatch(pkg.scripts['build:dev'], /@nekko-agent\/desktop/);
});
