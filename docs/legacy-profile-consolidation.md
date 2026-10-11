# Legacy profile consolidation: handoff

Branch `feat/legacy-profile-consolidation`. Read this, then `git log` on the branch. Everything below is in the
branch; nothing lives only in a chat.

## Why

Earlier names of the app (Nekko Paw, Open Paw, Kotrain, Agent Nekko) each wrote their own data folder, install
and updater cache. `migrateUserData` moves exactly one profile into an *empty* `~/.nekko-agent` and refuses
otherwise, so a person who tried several builds ends up with sessions, spending history and sign-ins split across
folders, plus gigabytes of dead installs and caches. The motivating machine (Windows) had data in `~/.agent-nekko`
(214 sessions, 14k usage records), `%APPDATA%\@agent-nekko` (17), `@kotrain` (25), `@open-paw` (12), `@nekko` (1),
two old installs, four updater caches and ~4,600 `kotrain-*` temp folders.

## What was built

| Piece | File | Notes |
|---|---|---|
| Detect, merge, verify, clean | `packages/host/src/legacy-profiles.ts` | Pure functions taking an injected `LegacyEnv`, so every path is testable. Exported as `@nekko-agent/host/legacy-profiles` (no node-pty) for the desktop main bundle, and from the host index for the CLI. |
| Close / reopen the app | `packages/host/src/app-control.ts` | Finds the app from `cli-link.json`'s pid, climbs to the window process, closes the tree (`taskkill /T`, forced after a grace period). Never climbs into a shell or dev launcher. |
| Terminal command | `apps/cli/src/migrate.ts`, wired in `apps/cli/src/run.ts` | `nekko-agent migrate [--dry-run] [--yes] [--keep-old] [--no-restart]`. Runs before `getClient`, which would refuse to open an unmerged root. |
| Launch prompt | `apps/desktop/src/main/legacyPrompt.ts`, called from `main/index.ts` | Native dialog before the engine starts. "Not now" is deliberately not remembered. |
| Spec | `SPEC.md`, "Consolidating earlier installs" | Status labelled implemented / unverified. |

Design rules, all covered by tests: additive only; target wins on conflict; usage logs unioned by line; delete
only what `unmerged()` proves is already in the target; a failed or refused merge deletes nothing; a backup of
changed files is written before the first change; refuse while another Nekko process serves from an involved folder.

## Verified

- `packages/host`: `legacy-profiles.test.ts` (12), `app-control.test.ts` (7), existing `user-data.test.ts` (7).
- `apps/desktop`: `legacyPrompt.test.ts` (8); `src/main` suite 78/78; typecheck clean (host, cli, desktop).
- Rehearsal on a sandbox copy of the real small files (script not committed): `migrate --yes` produced the exact
  union, 271 sessions and 15,508 usage records, kept every old provider and sign-in, and removed the sandbox
  copies. `migrate --dry-run` against the real machine lists everything above and changes nothing.
- Full host suite: 767/768 pass; the one failure (`session-clear.daemon.test.ts`) needs a built `nekkod.exe` and
  fails the same way on `main` in a fresh worktree.

## Not verified / known gaps (do these next)

1. **Desktop dialog never rendered.** Run the app with a seeded legacy profile (isolated `APPDATA`/`USERPROFILE`,
   see `AGENTS.md` on sandboxes), screenshot all three buttons and the result dialog, and attach to the PR.
2. **Real close-and-reopen from a terminal.** `findRunningApp`/`stopApp` are unit-tested with injected process
   lists; the real `taskkill` + relaunch of an installed app has not been run. Test with a packaged build.
3. **Windows uninstaller.** `defaultUninstall` calls `Uninstall <name>.exe /S _?=<dir>`; unverified against a real
   Kotrain/Open Paw install. NSIS silent uninstall keeps user data by default (see `build/installer.nsh`).
4. **macOS / Linux.** Detection uses injected dirs in tests only. macOS install paths are `~/Applications/*.app`;
   `/Applications` is not checked. Linux has no install/updater detection.
5. **Dev-build relaunch.** A development app is closed but not reopened (the command prints a note). If wanted,
   `scripts/dev-launch.mjs` could be invoked.
6. **Windows live-profile caveat.** The app being closed does not guarantee Chromium has released files in
   `%APPDATA%\...\desktop`; cleanup retries removal 3x and reports a failure rather than hiding it.
7. **Open product questions.** `Nekko Paw` (`%LOCALAPPDATA%\Programs\Nekko Paw`) is excluded because it may be a
   separate product; confirm with Philip. Backups in `~/.nekko-agent/backups/` are never pruned.
8. CI has not run; open the PR as draft until it does.

## Resuming

```
git fetch origin && git worktree add .worktrees/legacy-profile-consolidation feat/legacy-profile-consolidation
cd .worktrees/legacy-profile-consolidation && npm ci --ignore-scripts && npm run build:core
npm run build -w @nekko-agent/host && npm run build --workspace=apps/cli
node apps/cli/dist/index.js migrate --dry-run     # safe: changes nothing
cd packages/host && npx vitest run src/legacy-profiles.test.ts src/app-control.test.ts
```
