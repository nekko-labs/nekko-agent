---
status: accepted
date: 2026-11-26
---

# 0123. A computer on the network pairs through a relay lobby and a compared code

Issue: [#1492](https://github.com/nekko-labs/nekko-agent/issues/1492) (phase CC8). Proposal: [reports/phone-discovery-pairing-proposal.md](../../reports/phone-discovery-pairing-proposal.md), option C. Design: [connected computers](../superpowers/specs/2026-11-02-connected-computers-design.md), Plan step 8.

## Context

Two desktops paired only by pasting a link made on one into the other. Computers of the same Nekko Cloud account no longer need that (decision 0102), so what is left is two computers that don't share an account, usually on the same Wi-Fi. A network advert can't carry the room or its secret, since anyone on the network reads it.

## Options considered

1. **Discovery only** (the proposal's A): list the computer and still ask for the link. Saves little.
2. **A listener on the computer** (B): a short-lived inbound port. Breaks "dial out only".
3. **A lobby on the relay the computer already uses, and a compared code** (C).
4. **A typed code with a PAKE** (D): stronger against a hasty owner, but no vetted implementation on every platform we ship.

## Decision

Option 3, for desktops first.

- While *Make a link* is open, the computer joins a one-off room on its own relay, the lobby, as agent, and names it in its network advert (`pair=<room>`, `pairRelay=<url>`). The advert runs for that window even with *Visible on this network* off, and closes with it.
- The lobby is an ordinary relay room with a public credential (its own id). No relay change and no new ticket kind: Nekko Cloud already issues agent tickets for any room code.
- The joiner greets with a one-use P-256 key; the computer answers with its own. Both show a 6-digit code: SHA-256 over `nekko-pair-v1`, the lobby and both keys (the computer's first), its first four bytes mod 10^6. Both sides derive one AES-GCM key with HKDF from the ECDH secret and `nekko-pair-v1:<lobby>`. P-256, not the proposal's X25519: it is what every client already uses for its connection keys.
- Nothing is sent until the computer's owner taps **Pair**. Then it sends the very link it made, sealed. The joiner pairs with it as if pasted, so pinning the host key and protocol 6 apply unchanged. **Don't pair**, a joiner leaving, the page closing or ten minutes end the lobby. One exchange per lobby.
- 6 digits, not 8: one guess per window, against a person who opened that window.

## Consequences

- A stranger or a dishonest relay that swaps keys shows a different code on each screen. A hasty owner who taps Pair without comparing lets a neighbour in, as with any comparison code. The prompt names the computer asking, and the device can be revoked under Paired devices.
- Discovery is the local network only: the tailnet carries no multicast, so there a link is still pasted (or the computers share an account, decision 0102).
- Phones can adopt the same lobby later. They read the advert already, and would need the exchange and the code screen.
