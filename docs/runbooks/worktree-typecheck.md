# Typecheck an isolated worktree

Use a task worktree with its own dependencies and generated declarations. Do not
junction or symlink its `node_modules` to a checkout that another app or agent is
using. An ancestor's workspace links can silently resolve **that checkout's**
packages instead of the code you are editing (#1704).

## Bootstrap for TypeScript checks only

From the primary checkout, after inspecting its status and updating `main` safely:

```sh
git worktree add -b fix/my-task .worktrees/my-task main
cd .worktrees/my-task
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w @nekko-agent/shared
npm run build -w @nekko-agent/profile
npm run typecheck -w @nekko-agent/desktop
```

These commands work in a POSIX shell, PowerShell or `cmd.exe` (run each line in
order, stop at a failure). Use a new branch and directory for your task; do not
reuse or clean up another task's worktree. Node must satisfy the repository's
`engines` requirement, currently 22.12 or newer.

- `npm ci` installs from this worktree's lockfile, makes workspace links point at
  this worktree, and installs nested dependencies such as desktop's
  `@vitejs/plugin-react`. It replaces **this directory's** dependency installation;
  run it only after confirming you are in the intended task worktree.
- `--ignore-scripts` is sufficient for these TypeScript checks and avoids install
  hooks such as Electron's binary download. This is **not a runtime bootstrap**:
  it does not prove Electron, native helpers or the Rust daemon can run. Follow
  [the normal development setup](../../CONTRIBUTING.md#development-setup) with a
  full install and an isolated app profile before interactive verification.
- Building `shared`, then `profile`, produces current declarations in this
  worktree only. The desktop typecheck also uses the `source` export condition
  for `shared` (`apps/desktop/tsconfig.json`); that protects against stale `dist`
  types but cannot fix a workspace link pointing at a different checkout.
- The command above checks desktop, not every workspace. For all TypeScript
  workspaces, run `npm run typecheck` after preparing their build prerequisites.
  A successful typecheck is not a production build, a test run or app evidence.

No global module mapping, TypeScript `paths` override, copied `dist` directory,
shared root `node_modules` junction, or change to the primary checkout is needed.

## Verify where dependencies come from

Run this from the **task worktree root**, after installing:

```sh
node -e "const fs=require('node:fs'),p=require('node:path'),{createRequire}=require('node:module'); for(const name of ['shared','profile']) console.log(name,fs.realpathSync('node_modules/@nekko-agent/'+name)); const desktop=createRequire(p.resolve('apps/desktop/package.json')); console.log('react plugin',desktop.resolve('@vitejs/plugin-react')); console.log('typecheck compiler',require.resolve('typescript/package.json'));"
```

Every printed path must be inside this task worktree:

- `shared` and `profile` point to its `packages/shared` and `packages/profile`.
- The React plugin resolves from desktop's dependency context. npm may hoist or
  nest it depending on the lockfile; either is fine **inside this worktree**.
- TypeScript resolves from its own installation, not an ancestor's.

If the output points elsewhere, stop: inspect your working directory and any
existing links before reinstalling. Do not delete or replace an unknown junction
that might belong to another running checkout. Missing modules after a branch
update usually mean dependencies need refreshing from the new lockfile, not that
compiler checks should be suppressed. Missing `profile/dist` declarations mean
its build prerequisite has not run. Preserve real source diagnostics once the
resolution paths and build prerequisites are correct.

## Verification record

Verified in a fresh Windows worktree at `aa0e3b3cc`, with Node 24.1.0: clean
`npm ci --ignore-scripts --no-audit --no-fund` (630 packages), the two builds,
standard desktop typecheck, and the resolution command above all passed. The
plugin was nested at `apps/desktop/node_modules/@vitejs/plugin-react`; both
workspace packages and the compiler resolved locally. No primary-checkout files
or running app data were changed. Install emitted existing transitive-package
deprecation notices; dependencies were not upgraded as part of this recipe.

macOS/Linux fresh installs and runtime/native builds were not exercised for this
documentation change. Existing CI coverage does not stand in for those local
bootstrap checks.
