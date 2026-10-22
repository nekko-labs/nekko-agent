# Research key ceremony

"Help improve Nekko Agent" is opt-in. A sample a user chooses to share is redacted on their device and sealed to Nekko Labs' **research key** before upload (`seal_donation` in `crates/nekko-sync`). Nekko Cloud stores only that ciphertext. The research key's private half must never be on a server, a laptop that goes online, or in a repository. This page is how it is made and kept.

> **Status (2026-10-22):** the script (`scripts/research-key.mjs`) is in the repo and tested against the shared vectors. The key itself has **not** been generated: that has to happen on an offline machine, by Philip, following the steps below. Donations stay off in every app until its public half is pinned (TASKS ES-8).

## What you need

- A computer that will stay offline for this: an old laptop with Wi-Fi off, or a live USB system (Tails or a fresh Ubuntu live session) with networking unplugged. It must not have been used for anything sensitive, and it will not go online again while holding the key.
- Node.js 20 or newer, installed before going offline (from nodejs.org, checksum verified).
- `scripts/research-key.mjs` from a tagged commit, copied on a USB stick, with its SHA-256 written down.
- Two encrypted USB sticks (for example VeraCrypt or LUKS volumes with a strong passphrase), and a paper notebook.

## Generate

1. Disconnect the network. Check with `ip link` (Linux) or the menu bar that nothing is connected.
2. Check the script: `sha256sum research-key.mjs` matches what you wrote down.
3. `node research-key.mjs generate research-key.pem`
   - It writes the private key with mode 0600 and refuses to overwrite an existing file.
   - It prints the **public key** (base64url, 88 characters) and its **fingerprint** (16 characters in four groups).
4. Write the fingerprint in the notebook. Copy the public key onto a separate, plain USB stick (it is public).
5. Copy `research-key.pem` to both encrypted sticks. Check each copy: `node research-key.mjs public /media/…/research-key.pem` prints the same fingerprint.
6. Delete `research-key.pem` from the machine and power it off (on a live USB, the machine keeps nothing).
7. Store the two sticks in two places (a safe at the office, and a bank box or another trusted location). Their passphrases go in the company password manager, never on the sticks.

## Pin the public half

On a normal machine, a pull request sets the public key where the apps read it (ES-8: one constant per app; Rust `nekko-cloud`, Swift `NekkoKit`, Kotlin `protocol`). The PR description states the fingerprint, and a second person checks it against the notebook before merging. The apps show the fingerprint in *Help improve Nekko Agent*, so anyone can compare it with the one published on nekkoagent.com/security.

## Open donations

Donations are opened only for research, in batches, offline:

1. Export the batch from Nekko Cloud as `[{ id, blob }]` (no other columns exist).
2. Carry the file to the offline machine, mount one encrypted stick.
3. `node research-key.mjs open /media/…/research-key.pem donations.json opened.json`
4. Work with `opened.json` on that machine, or on one approved for research data. Delete it when the study is done. Donations expire on the server after 180 days in any case.

## Rotate or retire

- **Rotate** if a stick is lost, if anyone who knew a passphrase leaves, or every two years. Generate a new key, pin it (the old one stays in the apps only as long as old donations need opening), and destroy the old sticks.
- **If the private key may have leaked**, assume every stored donation is readable. Delete all stored donations at once (`delete from donations`), pin a new key, and say so publicly. Synced chats are not affected: the research key never touches sync.
