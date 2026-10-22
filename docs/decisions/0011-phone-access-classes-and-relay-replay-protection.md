---
status: accepted
date: 2026-10-22
---

# 0011. Class every phone channel, sign mode raises, and challenge every relay connection

## Context

A security review of the phone path (2026-10-22) found three gaps:

- The phone gate (`crates/nekko-remote/src/phone.rs`) checked the *Read* and *Change* switches only for the IO-33 channels (files, git, terminals). About 30 channels were in no class and went straight through, among them everything that makes the agent act: `chat:send`, `tool:approve`, `chat:answer`, `task:runNow`, `workflow:run`, `settings:update` and `session:setOptions`, which can set a chat to YOLO. A phone with Change off could still run the agent with no approvals.
- The relay agent welcomed a sealed HELLO on its device id alone, and requests carried no counter. The relay never sees plaintext, but anyone who can see its traffic (the managed relay, or the LAN relay, which is plain `ws://`) could record a phone's sealed HELLO and requests and replay them into a new connection, or repeat a request on a live one.
- The agent kept every announced connection in a list with no cap and found them by linear scan.

## Options considered

1. **Require a signed proof for every agent call.** Strongest, but every prompt and approval would need Face ID, and Android has no signer yet, so Android would stop working.
2. **Class every channel; the Change switch for agent calls, a proof only to raise a chat's mode.** The switches mean what they say, the most dangerous single action (fewer approvals) is confirmed on the phone, and Android keeps working for everything but raising the mode.
3. **Keep unclassified channels passing through.** Rejected: a new channel added to the allowlist without a class would again reach the computer with no switch checked.

For replay:

1. **Rely on TLS to the relay.** Does nothing against the relay itself or a plain `ws://` LAN relay.
2. **A per-connection challenge in the sealed HELLO and a challenge-bound rising `seq` on requests.** Binds every accepted frame to one live connection, inside the encryption, at the cost of one frame per connection.
3. **A per-request timestamp and nonce cache.** Needs clocks and memory per device; the connection binding is simpler and exact.

## Decision

Option 2 for both. Every channel a phone may call is in exactly one class (read, change with proof, agent: Change without proof, token, open); a channel in none is refused. Raising a mode (`session:setOptions` `mode`, `settings:update` `defaultChatMode`, above the current one) needs a signed Change proof. The agent seals each connection a random challenge on `client-open`; a HELLO declaring protocol 4 must answer it, once; requests on such a connection carry the challenge and a rising `seq`; anything else is dropped and the connection re-challenged rather than kicked (a kick reads as *unpaired* on the phones). Phones from before protocol 4 are accepted for one release behind `acceptLegacyPhones` (default on), logged and marked on the device. Connections waiting for a HELLO are capped at 64, oldest evicted, in a map by cid.

## Consequences

- Turning Change off now really stops a phone driving the agent; the activity list gets an entry for every prompt, approval and run from a phone, so it fills faster (200 kept per phone).
- An iPhone confirms Guardrails or YOLO with Face ID; Android can't raise a mode until its signer (AN-30).
- A legacy phone is still replayable until IO-35 turns legacy off; a new phone talking to an old computer waits 3 seconds before its legacy HELLO, and an active attacker who suppresses the challenge can force that downgrade while legacy is accepted. Once a phone has seen a challenge it never falls back in that session.
- The agent's replies and events are not counter-protected (they are sealed once for all phones); a replayed event can mislead a phone's screen but cannot make the computer act.
- Spec: [spec/phone/phone-access-classes-and-relay-replay-protection.md](../../spec/phone/phone-access-classes-and-relay-replay-protection.md). Tasks: IO-34, IO-35 in [TASKS.md](../../TASKS.md).
