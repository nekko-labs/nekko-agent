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
| `crates/` | The engine, in Rust: `nekkod` (the daemon every edition starts) and the crates it is built from (providers, the agent loop, tools, context, chats, automation, the model server, the phone relay agent). Tested with `cargo test`. |
| `packages/shared` | Types + IPC contracts (pure, no runtime deps) |
| `packages/profile` | The user's data folder on this machine: where it lives, moving it, older installs' profiles |
| `apps/desktop` | Electron app: `src/main` (Node), `src/preload` (bridge), `src/renderer` (React) |
| `apps/cli` | The `nekko-agent` CLI and MCP server, on a private nekkod or a running app |
| `apps/local-web-ui` | The Local Web UI server: the same React UI over HTTP, in front of nekkod |
| `apps/website` | Static marketing site |

**Rule of thumb:** engine behaviour goes in `crates/` (testable with no app at all); the apps are the UI and the transport in front of nekkod.

## Publishing the `npx nekko-agent` package

`npm run bundle:web` produces a self-contained package in `apps/local-web-ui/cli-dist/`
(server + engine bundled by esbuild, plus the built `web/` UI). To release it:

```bash
npm run bundle:web
cd apps/local-web-ui/cli-dist && npm publish
```

After that, anyone can run the Local Web UI with `npx nekko-agent`.

## Before you open a PR

Keep the build green and the suite passing:

```bash
npm run build       # Rust daemon (nekkod), then shared → profile → cli → desktop
npm test            # tests in every workspace (one Vitest run over all of them)
npm run typecheck   # every TypeScript workspace
```

`npm test` runs the root `node --test` scripts, desktop's `test:node`, then a single
`vitest run` whose projects (root `vitest.config.ts`) are the six workspaces. Narrow it
with `npx vitest run --project apps/desktop`, or run one package as before with
`npm test -w @nekko-agent/desktop`. The engine's tests are `cargo test --workspace`.

- Add tests in `crates/` for new engine behavior (providers, guardrails, agent loop, context); real-binary tests of the daemon go in `crates/nekkod/tests/daemon`.
- Desktop UI flows: add a step to a journey in `apps/desktop/e2e/` (`npm run test:e2e -w @nekko-agent/desktop`, hidden windows only; see its README) rather than a new one-off script.
- Match the surrounding code style; keep changes focused.
- For provider changes, verify against a real local server: point a provider at it and run a chat through the CLI on this checkout's nekkod (`NEKKOD_PATH=target/debug/nekkod node apps/cli/dist/index.js chat "hi" --new`). A local server may not be on its default port (LM Studio's is 1234, but it can be moved): `lms server status` reports where LM Studio is listening, and `lms ls --json` is the only place it publishes a model's `sizeBytes` (its HTTP API has no size or layer geometry).

## Documentation

The docs at [nekkoagent.com/docs](https://nekkoagent.com/docs) are rendered from Markdown in this repo. `docs/hub/nav.json` lists the pages and the file each comes from. The generated pages are not committed: Vercel builds them on every deploy, so a docs change is just the Markdown edit. When a pull request changes what users see or do, update the page that describes it in the same PR.

To look at the result before it ships, `npm run website` builds the docs and serves the site on `http://127.0.0.1:8080` (set `PORT` to change it), with the same clean URLs as production.

```bash
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
