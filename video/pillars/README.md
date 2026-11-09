# Pillar demos

Five 8 s demos, one per Nekko Agent product pillar, for the nekkolabs.com
flagship and (later) nekkoagent.com:

| Composition | Shows |
| --- | --- |
| `Pillar-local-{dark,light}` | Picking a local model on the built-in engine, then Claude Code calling it over MCP (`claude mcp add nekko-agent -- nekko-agent mcp`, `nekko-agent_model_load`, `nekko-agent_chat`) |
| `Pillar-speed-{dark,light}` | Side-by-side replay of the whole-file rename: Nekko Agent 2.5 s, Ollama 13.9 s (fast-forwarded after 5 s). Numbers from `docs/benchmarks`, 2026-10-30, M5 Max, Qwen3-8B |
| `Pillar-privacy-{dark,light}` | Privacy Shield swapping an email and card number for placeholders, then the end-to-end encrypted phone relay |
| `Pillar-fleet-{dark,light}` | Connected computers and cloud plans as one fleet, three chats running on three of them |
| `Pillar-anywhere-{dark,light}` | One chat on desktop, iPad, phone and a folding phone; a command approved from the phone |

1280x720, 30 fps, loops (each fades in from and out to the background). Colours
are the app's tokens (`apps/desktop/src/renderer/styles.css`, `:root` and
`[data-theme='dark']`), and layouts follow `docs/design-system.md`. They are
illustrations, not screen recordings, apart from the measured times in the
speed demo. Fonts in `public/fonts` are copies of `apps/website/fonts` (OFL-1.1).

    npm install
    node render.mjs [path-to-chrome-headless-shell]

writes `out/pillar-<id>[-light].mp4` (H.264, CRF 24) and `-poster.jpg`.
Existing MP4s are kept; delete `out/` to render everything again. Preview with
`npx remotion studio src/index.tsx`.
