---
status: accepted
date: 2026-11-26
---

# 0124. Chat records are deflated before they are sealed, once every device of the account can read them

## Context

A chat record is up to 16 MB of JSON, mostly tool output, and a push request carries up to 6 MiB of them. The sealed record is then base64 on the wire, so it costs a third more again. Ciphertext does not compress, so the saving has to be taken before sealing (item 1.6 of the cloud calls and UI speed report, 2026-11-26). Compressing on the client keeps the boundary where it is: Nekko Cloud still receives only ciphertext, and nothing but the client ever sees the plaintext.

The risk is the fleet. An account has computers and iPhones on different builds. Today a build that meets a blob version it does not know skips the record (`open_record` fails, the pull moves its cursor on), so a chat that another device compressed would stop updating on it and never be read again. Nothing is lost on the server, but the user loses the chat on that device, and a device that then pushes its own copy meets a revision conflict. This is the one thing the rollout must not do.

## Options considered

1. **Compress, version the blob, and ship.** Simple, and breaks every device that has not updated.
2. **Readers first, then writers on a date.** Better, but "everyone has updated by now" is a guess: a phone left on an old TestFlight build, or a computer that is off for a month, is exactly the device that breaks.
3. **Readers first, and a writer that compresses only when every device of the account says it can read the format.** The account already keeps a sealed list of its devices that only holders of the keys can write, so the devices can say what they read there without a server change.

## Decision

Option 3, in two steps, with a remote switch on top.

**Format.** A record blob has a version byte. Version 1 (unchanged) seals the plaintext. Version 2 seals the raw deflate (RFC 1951, no zlib header or checksum) of the plaintext, framed and Padmé-padded as before. The associated data of a version 2 blob ends with `\ncodec\ndeflate`, so the version byte is authenticated: flipping it makes the tag fail rather than hand garbage to a parser. Key derivation is unchanged (a fresh salt per record).

**Where it applies.** Only `chat` records, and only when the plaintext is at least 1024 bytes and deflating makes the padded sealed size smaller; otherwise the record is sealed as version 1. Account, `picture` (already compressed image bytes in base64), `library`, org and fleet records are never compressed, so the account record in particular stays readable by every build, always.

**Size limit.** A record opens to at most 16,000,000 bytes (the chat cap) whether or not it was deflated. Inflating stops at the limit and refuses the record, so a corrupted or hostile record cannot become a decompression bomb. A truncated or garbage stream is refused. Only a holder of the account keys can make a version 2 blob at all, because the tag has to verify first.

**Algorithm.** Deflate: the `flate2` crate (MIT or Apache-2.0, pure Rust backend) on the computer, Apple's Compression framework (`COMPRESSION_ZLIB`, which is raw deflate) on the iPhone. Both are permissive or part of the OS. LZFSE is faster on Apple devices but has no Rust implementation we can take, and a record sealed on the computer has to open on the phone. Deflate output differs between implementations, so the shared vectors are not compared byte for byte: `sync-compressed.json` holds records each side made, and each side must open both.

**Step 1, readers (this PR).** Both clients open version 1 and 2. Each also lists what it can do in the sealed account record: a device's entry gets `"caps": ["z1"]` and the record may carry `"compressed": true`. The record stays `v: 2`; an older build ignores both fields, and drops them if it rewrites the record, which can only turn a capability off. A device lists `z1` for itself the first time it syncs on a build that can read the format (a single write to the account record, never repeated). Nothing compresses yet.

**Step 2, the gated writer (#3451).** A computer compresses a chat record only when all of these hold:

- the remote switch is on (below), and the local off switch is not set;
- the sealed account record of the epoch it holds lists at least one device and every one lists `z1`;
- Nekko Cloud's own device list (`/v1/sync/state`) has no registered, unrevoked device that the sealed record does not list. That stops a device that is registered but still waiting for approval from becoming a reader we have not heard from.

The gate is checked on every push, from data the pass has already read, so it costs no request. The moment a device that cannot read the format joins (its entry has no `z1`), or one is added but not yet approved, writers fall back to version 1 on the next push; records already written stay as they are.

**A device that joins late, or updates late.** Records compressed before it could read them are skipped by an older build. A build that can read the format, the first time it runs on a state that already had a pull cursor, looks at the account once: if the account record says `"compressed": true` (the writer sets it before its first compressed push, and sets it again on a push if it is missing) the device pulls again from the start. Records it already read are skipped by its revision table, so only what was passed over is applied. It reads Nekko Cloud's copy of the account record rather than its saved one, because an older build that rewrote the record would have dropped the mark.

**Remote switch.** The writer also needs the account's `sync-compression` feature (the existing feature switches of decision 0092: off, team, on), so it can be turned on for the team first, widened, and turned off again at once without a release. An API that does not know the switch answers without it, which reads as off. The switch is a small additive change to `apps/nekko-agent-api`; it is not deployed by merging (the API deploy is manual). Until it is deployed and set, no build compresses.

**Not compressed: the iPhone's writes.** The iPhone does not push chats today, so it only reads. Android has no sync client. When either starts writing chats it uses the same gate.

## Length and compression side channels

Compression can leak when an attacker controls part of a plaintext that is compressed together with a secret and can observe the size (CRIME, BREACH). A chat record has no such mix. The attacker would have to be someone who can put chosen text in front of the user's chat and see the sealed length, and the only party that sees sealed lengths is Nekko Cloud, which does not choose the chat's content. Text the model or a web page puts into a chat (tool output) is not a secret from the user's other devices, which hold the same record, and the keys that matter (API keys, tokens) are not in chat records. What the server could learn is the compressed size of the whole record, in Padmé buckets (at most 12% granularity, about log log n bits), where it used to learn the uncompressed size in the same buckets. That is a length leak of the same kind and size as today, about the compressibility of a chat instead of its length. We accept it and record it in [SYNC-ENCRYPTION.md](../SYNC-ENCRYPTION.md).

## Consequences

- Pushes and pulls of long agent chats get several times smaller on the wire and in Nekko Cloud's storage, and a plan's synced storage counts the smaller bytes. The measured numbers are in [perf-history.md](../perf-history.md) with the writer.
- Compressing and inflating costs CPU on the computer (measured with the writer).
- Until every device of an account lists `z1`, that account's records stay version 1: an account with one forgotten old phone never compresses, by design. Removing that device (which rotates the epoch) lets the rest compress.
- A device on a build older than this PR that joins after compression began sees only the chats written as version 1 until it updates, then catches up by itself. Nothing is lost on the server at any point.
- The account record has two new optional fields, and `docs/SYNC-ENCRYPTION.md` describes them.
- To turn it on: ship this PR's readers in a release, wait until the devices people actually use have updated, deploy the API with the `sync-compression` switch, set it to `team`, watch, then `on`. The gate, not the date, decides per account.
