# Decisions

One file per decision that closes off alternatives, technical or product: `NNNN-short-title.md`, numbered in order, never renumbered. The format is [MADR](https://adr.github.io/madr/) cut down to what an agent and a reviewer need (see [0000-template.md](0000-template.md)).

- A decision is **append-only**. To change one, write a new record that supersedes it and set the old one's status to `superseded by NNNN`.
- The spec says *what* the product does ([spec/](../../spec/README.md)); a decision says *why this and not that*. Link the two both ways.
- Earlier decisions are still recorded inline: "Key Technical Decisions" in [TASKS.md](../../TASKS.md) and the "(decided …)" sections in the spec. Move one here when you next change it.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-split-the-spec-into-feature-files.md) | Split SPEC.md into feature files, AGENTS.md into rules and runbooks | accepted |
| [0002](0002-bundled-model-feed-with-measured-calibration.md) | Recommend models from a bundled feed, with speeds calibrated on measurements | accepted |
| [0003](0003-size-the-kv-cache-per-layer-as-llama-server-allocates.md) | Size the KV cache per layer, as llama-server allocates it | accepted |
| [0003](0003-pseudonymize-private-values-at-the-model-client.md) | Pseudonymize private values at the model-client seam (Privacy Shield) | accepted |
| [0004](0004-code-mode-in-an-embedded-quickjs-sandbox.md) | Run code mode's scripts in an embedded QuickJS sandbox, calling back through the turn's own tool path | accepted |
| [0005](0005-supabase-for-identity-only.md) | Use Supabase Auth for identity only; keep accounts and data in Nekko Cloud | accepted |
| [0006](0006-recovery-key-as-a-p256-key-and-sealed-account-record.md) | Seal key epochs to the recovery key's public half; pin trust in a sealed account record | accepted; account record superseded by 0008 |
| [0007](0007-lockout-recovery-without-a-vendor-key.md) | Recover lockouts without a key Nekko Labs can use | proposed |
| [0008](0008-authenticated-wraps-and-join-codes.md) | Authenticate keyring wraps, approve devices with a join code, one account record per key epoch | accepted |
| [0009](0009-daemon-config-on-stdin-and-a-child-record.md) | Pass nekkod's config on stdin; track its children in one record rather than per spawn site | accepted |
| [0010](0010-guardrails-mode-auto-runs-only-read-only-commands.md) | Guardrails mode auto-runs only read-only commands; fetch_url asks before reaching the local network | accepted |
| [0011](0011-background-automations-wait-for-idle-on-local-models.md) | Background automations on a local model wait for idle; a waiting run starts after a cap | accepted |
| [0012](0012-phone-access-classes-and-relay-replay-protection.md) | Class every phone channel, sign mode raises, and challenge every relay connection | accepted |
| [0013](0013-apple-speech-through-a-helper-command.md) | Dictation on Apple's on-device recognizer through a helper command beside the daemon | accepted |
| [0014](0014-claude-agent-accounts-through-claude-config-dir.md) | Give each Claude Agent account its own Claude Code folder through `CLAUDE_CONFIG_DIR` | accepted |
| [0015](0015-experimental-dark-themes-use-a-60-30-10-split.md) | Build the Experimental Dark themes on a 60 / 30 / 10 split with near-black panels | accepted |
| [0016](0016-a-phone-carries-a-sealed-provider-key-and-never-holds-one.md) | A phone may carry a provider key sealed to a computer; it never holds or reads one | accepted |
| [0017](0017-nekko-cloud-machines-run-tools-in-a-per-user-jail.md) | Nekko Cloud machines run tools in a per-user jail; the phone decides what the cloud may see | accepted |
| [0018](0018-the-computer-is-the-relying-party-for-step-up.md) | The computer is the relying party for hardware keys and step-up; safety exits are never guarded | proposed |
| [0019](0019-folding-phones-get-panes-not-a-new-app.md) | Folding phones get posture-driven panes in the existing apps, not a tablet app or a device list | proposed |
| [0020](0020-one-network-switch-enforced-in-the-engine.md) | One network switch for every connection, enforced in the engine; All connections off is offline except loopback | accepted |
| [0021](0021-opt-in-reports-sent-by-the-engine.md) | Opt-in usage and crash reports, sent by the engine with an allow-list and scrubbing; no PostHog SDK | accepted |
| [0022](0022-ci-runners-vm-and-network.md) | CI runners use our own `nekko-vm` helper, a userspace public-only NAT in nekkod and a read-only seed disk; no privileged helper | accepted |
| [0023](0023-place-bytes-in-three-places-and-pass-placement-explicitly.md) | Plan a load across VRAM, RAM and disk by weight kind, and pass the placement to llama.cpp explicitly | accepted |
| [0024](0024-one-models-workspace-with-local-and-cloud-sections.md) | One Models rail entry with local and cloud subnavigation, preserving existing destinations | accepted |
| [0026](0026-thinking-on-with-local-expert-overrides.md) | Thinking on for cloud turns, local overrides only in model Expert settings | accepted |
| [0025](0025-the-computer-serves-what-the-agent-linked-to-the-phone.md) | The computer serves the phone what the agent linked in a chat (files, a page's assets, loopback previews), and nothing more | proposed |
| [0026](0026-retire-expo-in-favor-of-native-phone-apps.md) | Retire Expo in favor of native phone apps | accepted |
| [0028](0028-phones-read-the-monitors-and-unload-models.md) | Let phones read the hardware, the Model Server and a chat's context, and unload a model | accepted |
| [0029](0029-one-always-on-microphone-text-follows-the-focused-chat.md) | One always-on microphone for the whole app; single-shot dictation removed; text follows the focused chat | accepted |
| [0030](0030-a-composer-in-every-wall-window.md) | Give every wall window its own composer; retire the shared wall composer | accepted |
| [0031](0031-a-user-with-anthropics-approval-can-turn-on-the-plan-features.md) | A user with Anthropic's own approval can turn on the Claude plan's gated features, behind a warning | accepted |
| [0032](0032-three-layers-and-the-nekko-package.md) | Customizations, mods and custom layouts as three layers in one open `.nekko` zip format; customizations sync through encrypted sync | accepted |
| [0033](0033-mods-may-run-agent-tools-behind-a-permission.md) | Mods may run agent tools behind `tools:run`, the tool policy (Ask by default) and picked folders | accepted |
| [0034](0034-android-permits-cleartext-and-refuses-public-ws-in-the-app.md) | Permit cleartext app-wide on Android and refuse public `ws://` in the app, as on the iPhone | accepted |
| [0035](0035-plan-usage-on-for-claude-plans-from-claude-codes-own-output.md) | A Claude plan shows its usage limits, read only from what the user's own Claude Code printed | accepted |
| [0036](0036-the-relay-sees-a-derived-room-credential-never-the-pairing-secret.md) | The relay sees a room credential derived from the pairing secret, never the secret; older pairings are replaced and phones pair again | accepted |
| [0037](0037-route-each-message-once-to-a-local-model-or-claude-code.md) | Route each message once, before the turn, to a local model or the user's Claude Code, passing it through unchanged | proposed |
| [0038](0038-image-builder-reaches-a-build-vm-over-ssh.md) | The image builder reaches a build VM over SSH, from Apple's restore image, with no shared folder (amends 0022) | accepted |
