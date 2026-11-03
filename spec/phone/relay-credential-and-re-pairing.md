---
title: "Relay credential and re-pairing"
area: phone
---

# Relay credential and re-pairing

`[implemented 2026-11-01; Rust, TS and Android unit tests pass, plus the daemon's end-to-end relay test; Swift tests run in CI only; not yet run on a device against the managed relay]` Decision record: [docs/decisions/0036](../../docs/decisions/0036-the-relay-sees-a-derived-room-credential-never-the-pairing-secret.md).

## User intent

The relay that connects a phone to its computer only forwards sealed frames. It must not be able to read them, so it must never receive anything the encryption key can be derived from.

## Behavior

- The computer and every client (iPhone, Android, browser) present the relay with a room credential derived from the pairing secret under its own label (`hex(HMAC-SHA256(secret, "nekko-relay-auth:" + room))`), never the secret. The end-to-end key is derived from the secret as before, so the relay has no input to it.
- The first time a computer starts with this version, it replaces its room and pairing secret (both were seen by the relay before) and keeps its list of paired devices and their switches. `remote.json` records `pairing: 2`.
- Phones store the pairing format with each computer. A computer saved by an older app is not dialed; the app shows that the pairing key changed and to pair again from *Settings → Remote access → Pair a device* on the computer. The same message shows when the relay refuses the credential (`bad pairing key`).
- The browser client drops a saved pairing from before this change and asks to pair again.
- `[implemented 2026-11-01]` Every HELLO is signed with the device's own key (phone protocol 5): a silent P-256 key in the iPhone's Secure Enclave, the Android Keystore, or WebCrypto in the browser. The signed text is `nekko-hello-v1`, the deviceId, the room and the connection's challenge, one per line. A device enrolls its key with the live pairing code; afterwards the computer welcomes it only when its HELLO verifies with that key. A device paired before this, or with a reinstalled app, gets the pair-again message (`bad-key`); a phone app older than protocol 5 is told to update. Keys live in `remote-hello-keys.json` beside `remote.json` and are forgotten by *Sign out all phones*.

- `[implemented 2026-11-02; Rust, TS, Android and iPhone unit tests pass, plus two real engines through a stand-in relay; not run on a device against the managed relay]` The computer proves itself and every connection has its own key (phone protocol 6, decision [0041](../../docs/decisions/0041-a-computer-proves-itself-and-every-connection-has-its-own-key.md), [#1501](https://github.com/nekko-labs/nekko-agent/issues/1501)). The pairing link carries the computer's public key (`host=`), which a device pins; a link without one can't pair, and no device trusts a key it first saw on the wire. Each connection's challenge carries the computer's one-use key and the host key's signature; a device that can't verify it sends nothing, the pairing code included. Both ends derive a key for that connection alone and every later frame is sealed under it, the HELLO first, and the HELLO's signature covers both one-use keys. The room secret now only reaches the relay and carries the challenge: a device ignores anything else sealed under it, and the computer refuses any HELLO under it with `update-required`. The first start with this version replaces the room, secret and host key (`pairing: 3`) and keeps the device list, so a secret a revoked device kept dies with the upgrade and every device pairs again once. Nekko Cloud mints a machine's key pair and puts the public half in its link.

## Acceptance

- The same vector (`secret`, `room` to `relayAuth`) passes in `crates/nekko-remote/tests/golden/crypto.json`, `packages/shared/src/e2e.test.ts`, the Android `E2ETest` and the iPhone `E2ETests`.
- The agent's relay URL and every phone's dial URL carry the derived credential and not the secret (`crates/nekko-remote/tests/golden.rs`, `crates/nekkod/tests/daemon/remote.rs`, `RelayClientTest`, `RelayClientTests`).
- An older `remote.json` gets a new room and secret at start and keeps its devices; a current one is left alone (`crates/nekko-remote/tests/access.rs`).
- A stored pairing without the version is refused locally with the pair-again message and no connection is made (`ComputersRepositoryTest`, `StoreTests`).
- The signed text and a signature verify identically on the computer, both phones and the TypeScript client (`helloKey` in `relay-handshake.json`); enrollment keeps the key, a HELLO signed by another key, for another room or another challenge is refused, and an older app is told to update (`crates/nekko-remote/tests/golden.rs`, `crates/nekkod/tests/daemon/remote.rs`, `scripts/itest-relay-daemon.mjs`).

- The challenge, session key and signatures match on the computer, both phones and the browser (`crates/nekko-remote/tests/golden/relay-handshake.json`, rewritten from its inputs with `UPDATE_GOLDEN=1`).
- An impostor holding the room secret gets no HELLO; the room key can forge no refusal, reply or event on a welcomed connection; a replayed HELLO opens on no other connection; each connection's frames open only under its own key (`crates/nekko-remote/src/agent.rs`, `tests/client.rs`, and each phone's relay client tests).

## Not yet

- The room credential is shared, so a revoked device that kept it can still reach the relay, where it can interrupt the computer's connection and send content-free notifications until *Sign out all phones* replaces the room. Per-device relay credentials would close this.

- Re-pairing creates a new entry on the phone when the room changed; the old one stays (with the pair-again message) until removed.
