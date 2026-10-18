# Contributing to Nekko Agent

Thanks for your interest! Nekko Agent is an open-source, local-first AI coding & cowork desktop app. Contributions of all sizes are welcome.

## Development setup

Requires Node 22.12+ and a Rust toolchain ([rustup.rs](https://rustup.rs)): `npm run dev` and `npm run build` compile the engine daemon (`nekkod`). The project uses **npm workspaces** (not pnpm/yarn).

```bash
git clone https://github.com/nekko-labs/nekko-agent
cd nekko-agent
npm install
npm run dev          # build the Rust daemon and the app, then launch the desktop app
```

To stop a dev run, press **Enter** or **q** (or Ctrl+C) in its terminal. The app quits the normal way, stopping the engine and any model servers it started; press again to force it, which ends the whole process tree. A run that hasn't exited after 10 seconds is forced too.

## Project layout

| Path | What |
| --- | --- |
| `packages/shared` | Types + IPC contracts (pure, no runtime deps) |
| `packages/core` | Engine: providers, agent loop, guardrails, context, indexer, memory, connectors. **No Electron imports**, unit-tested with Vitest. |
| `apps/desktop` | Electron app: `src/main` (Node), `src/preload` (bridge), `src/renderer` (React) |
| `apps/website` | Static marketing site |
| `scripts/itest-local.mjs` | Manual end-to-end test against a real model server |

**Rule of thumb:** business logic goes in `packages/core` (so it's testable without Electron); the desktop app wires it to the filesystem, shell, and UI.

## Publishing the `npx nekko-agent` package

`npm run bundle:web` produces a self-contained package in `apps/web-app-server/cli-dist/`
(server + engine bundled by esbuild, plus the built `web/` UI). To release it:

```bash
npm run bundle:web
cd apps/web-app-server/cli-dist && npm publish
```

After that, anyone can run the web edition with `npx nekko-agent`.

## Before you open a PR

Keep the build green and the suite passing:

```bash
npm run build       # Rust daemon (nekkod), then shared → core → host → cli → desktop
npm test            # tests in every workspace (one Vitest run over all of them)
npm run typecheck   # every TypeScript workspace
```

`npm test` runs the root `node --test` scripts, desktop's `test:node`, then a single
`vitest run` whose projects (root `vitest.config.ts`) are the eight workspaces. Narrow it
with `npx vitest run --project packages/core`, or run one package as before with
`npm test -w @nekko-agent/core`.

- Add tests in `packages/core` for new engine behavior (providers, guardrails, agent loop, context).
- Desktop UI flows: add a step to a journey in `apps/desktop/e2e/` (`npm run test:e2e -w @nekko-agent/desktop`, hidden windows only; see its README) rather than a new one-off script.
- Match the surrounding code style; keep changes focused.
- For provider changes, you can verify against a real local server:
  `node scripts/itest-local.mjs http://your-host:port your-model-id`

## Documentation

The docs at [nekkoagent.com/docs](https://nekkoagent.com/docs) are rendered from Markdown in this repo. `docs/hub/nav.json` lists the pages and the file each comes from. The generated pages are not committed: Vercel builds them on every deploy, so a docs change is just the Markdown edit. When a pull request changes what users see or do, update the page that describes it in the same PR.

To look at the result before it ships, build it and serve it. `npm run website` serves the site on [http://127.0.0.1:8080](http://127.0.0.1:8080) (set `PORT` to change it), with the same clean URLs as production.

```bash
npm run docs
npm run website
```

Adding, removing or renaming a page in `nav.json` also changes the docs list in `apps/website/llms.txt` and the docs URLs in `apps/website/sitemap.xml`, which are committed. `npm run docs` updates them; if you forget, the **Docs site** workflow does it on your pull request and pushes the result to its branch.

## Commit messages

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Reporting bugs / requesting features

Use the issue templates. For local-model issues, please include your provider
kind (Ollama / LM Studio / vLLM / cloud), the base URL shape, and the model id.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
