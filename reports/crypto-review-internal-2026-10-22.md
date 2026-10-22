# Nekko Cloud E2EE sync: internal adversarial review

*Done 2026-10-22, before the outside review, by an independent reviewer reading the code cold. Line numbers refer to the code as it was then (commit `1c729c5` on the `cloud-sync` branch); the fixes moved most of them. **[What was done](#what-was-done)** at the end maps every finding to its fix and test.*

## Summary

The primitives in `crates/nekko-sync` are sound: there is no nonce or key reuse, the AAD binding is correct, and recovery-key derivation is unbiased. The protocol around them is weak. **Keyrings are never authenticated.** ECIES gives the recipient no proof of who sealed a wrap. Clients accept any wrap that decrypts, for any epoch the server announces, and overwrite the keyrings they already hold. Neither a server compromise nor another device is needed: **anyone who can sign in to the account** can make every device switch to an attacker-chosen keyring and then read every chat written after that. Signing in only takes the emailed code. Approval has a time-of-check/time-of-use (TOCTOU) gap between the fingerprint the user compares and the key the client wraps to. Rollback protection can be switched off by the server, and old key epochs stay writable. Together these break the "revoked device reads nothing new" goal whenever the server colludes.

## Confirmed issues (code paths traced)

### C1. CRITICAL: devices accept and store server-chosen keyrings (no sender authentication on wraps)
- `lib.rs:704-729` (`finish_join`) and `lib.rs:851-861` (`pass`) call it whenever `currentKeyId` from `/v1/sync/state` is above the local `key_id`, or when no keyring is held yet.
- iOS: `CloudSync.swift:297-299` and `317-336` (`takeWraps`).
- Primitive: `crates/nekko-sync/src/wrap.rs:80-109`. ECIES with only an ephemeral sender key means anyone who knows a device's public key can make a valid wrap.
- Server side: `apps/nekko-agent-api/src/sync.ts:151-181` lets **any** token of the account `PUT /v1/sync/keyrings/{current+1}`. `sync.ts:184-195` and `316-325` let it overwrite (`on conflict do update`) the wrap of **any** device for **any** existing epoch. There is no device binding and no check that the caller is a trusted device.
- **Attack** (only needs the ability to sign in to the account: email OTP, a stolen Supabase session, or a malicious server):
  1. Read `/v1/sync/state` to get the account id, device ids and device public keys.
  2. Generate keyring K*. `PUT /v1/sync/keyrings/{n+1}` with K* wrapped to every device under the correct context (`nekko-sync/v1 wrap\n{account}\n{n+1}\n{deviceId}`, all public) and a junk recovery wrap of 146 bytes.
  3. Each device then runs `pass()`. It sees `remote_key > key_id` and calls `finish_join`, which unwraps K* and stores it as `keyring:{n+1}` (`lib.rs:717`). It then sets `key_id = n+1` and pushes every changed chat under K*.
  4. The attacker decrypts everything written from then on. The same attacker can also forge an account record under K*: devices pinned to a recovery key accept any record with the right `recoveryPublic`, and devices joined by approval accept anything (C6). That lets the attacker add their own device to the trusted list.
  5. `finish_join` loops over `1..=current` and calls `store_keyring(k)` for every wrap that opens. Overwriting old wraps (`sync.ts:320`) therefore also **replaces the device's good keyrings for old epochs**. That destroys access to old records (DoS) and makes old-epoch writes use attacker keys too.
- **The same flaw hits a new device joining by approval.** The server can wrap K* to it before any real approval happens. The joining device never checks who approved it, because the fingerprint comparison runs in one direction only.
- **Fix:**
  - Authenticate every keyring delivery. Give each device a signing key (or use HPKE Auth mode, i.e. static-static ECDH with the sender's device key). A wrap or epoch announcement is accepted only if it is signed by a device in the *currently trusted, authenticated* device set.
  - Never overwrite a keyring that is already held. Accept a new epoch only when it comes with an authenticated rotation statement signed by a trusted device.
  - On join, the new device must also authenticate the approver, for example by showing both fingerprints or a short authentication string (SAS) over both keys.
  - Server side: allow `PUT keyrings` and `PUT wraps` only from a token bound to a non-revoked device, and refuse to overwrite an existing wrap.

### C2. HIGH: TOCTOU in approval, so the key that gets wrapped is not the one the user compared
- Rust: `lib.rs:732-764`. `approve(device_id)` takes only an id, calls `refresh()` again (`734`) and wraps every epoch's keyring to whatever `publicKey` the server returns *now* (`745-753`). The fingerprint the user compared came from an earlier `/v1/sync/state` (`status()`, `lib.rs:310-314`).
- iOS: `CloudSync.swift:269-287`, same pattern. iOS also has no `revokedAt` check.
- **Attack:** a malicious server shows device D with the real new device's key while the user compares codes. When "Approve" is pressed, it answers the next `/v1/sync/state` with D's `publicKey` set to its own key. The approving device wraps **all epochs' keyrings** to the server and writes the server's key into the sealed account record as trusted (`757-762`). The server now reads everything and stays trusted across future rotations.
- **Fix:** `approve` must take the fingerprint (or the full public key) the user confirmed and check that `fingerprint(public) == confirmed` before wrapping. Better: use the full key or a longer SAS, and pin it in the account record.

### C3. HIGH: the server can turn off the rollback guard by lowering the "seen" revision
- Rust chat push: `lib.rs:1050-1058`. On `conflict`, the stored `seen` revision is **lowered** to the revision the server claims.
- Rust account record: `lib.rs:581-587` sets `revisions[oid] = have` unconditionally.
- iOS: `CloudSync.swift:432`.
- `apply()` only rejects `rev <= seen` (`lib.rs:900`). The account record has no freshness check of its own (`906-921`).
- **Attack:**
  1. The server answers one push with `conflict, revision: 1`.
  2. On the next pull it replays an old genuine account-record blob (revision 2 or more, possibly from an old epoch the device still holds). That record lists a since-revoked device R.
  3. The device installs it as `account_record`.
  4. The next `revoke()` or `approve()` starts from that list. `revoke()` keeps only devices the server reports as live (`778-782`, server-controlled), so the next epoch is wrapped to R. R gets current keys back.
  5. Same trick for chats: replay a pre-deletion chat revision after a tombstone. Locally the chat is gone, so `is_none_or` is true (`949`) and the **deleted chat comes back** (`put_synced`).
- **Fix:**
  - Never lower `seen`. Treat a conflict claim below `seen` as server misbehaviour.
  - Put a monotonic counter and the epoch inside the account-record plaintext, and refuse older ones.
  - Keep tombstones locally and refuse to resurrect a chat unless the incoming `updatedAt` is newer than `deletedAt`.

### C4. HIGH: old key epochs stay writable and readable, so a revoked device plus the server can forge and read
- `lib.rs:903-904`: `apply()` opens a record with whatever `keyId` the server attaches, as long as the device holds that keyring. Nothing requires `kid == current` for new revisions, and the account record is accepted from any epoch.
- (a) **Forgery.** A revoked device R keeps keyring n (and the id key, which never rotates; `record.rs:44-46`). It seals a new account record or chat under epoch n with `revision = latest+1`. A malicious server serves it, and every device accepts it. Forging the account record adds R back as trusted, so the next rotation is wrapped to R.
- (b) **Hiding a rotation.** `pass()` trusts the server's `currentKeyId` (`lib.rs:855-861`). The server can hide epoch n+1 from the other devices and keep accepting their pushes under epoch n (a malicious server ignores its own `stale-key` check). Objects under an unknown epoch are dropped silently (`903`). R keeps reading everything written after it was revoked.
- (c) **Restoring into an old epoch.** `restore()` and `finish_join()` take `current` from the server (`lib.rs:663`, `707`; iOS `242`, `321`). A server that reports a lower `currentKeyId` makes a freshly restored or approved device write under an old epoch that R knows.
- **Fix:**
  - Record the current epoch inside the authenticated account record, together with a rotation statement signed by a trusted device (see C1).
  - Refuse to open *new* revisions under an epoch older than the newest authenticated epoch.
  - Refuse to push when any epoch above the local one has been seen.
  - Fully preventing a forking server needs fork-consistency checks (devices cross-checking epoch and record heads). At minimum, document that a malicious server can partition devices.

### C5. MEDIUM-HIGH: a forged recovery wrap is accepted on restore (anyone who knows the recovery public key)
- `lib.rs:665-675` and `CloudSync.swift:246-257`: restore accepts any recovery wrap that opens with the recovery key, then **wraps it to the device and stores it**.
- The recovery *public* key is a plain field in the account record (`records.rs:111-121`), so every device that ever read the record knows it, including revoked ones. Such a party can seal any keyring to it (ECIES needs no secret).
- **Attack:** R and the server replace `recovery_wrap` for epoch k with K*. A user restoring onto a new device adopts K* for that epoch and writes under it.
- **Fix:** authenticate epoch keyrings (C1). For example, store `H(keyring_k)` in a structure signed by a trusted device, or derive a signing key from the recovery key and have it sign each epoch's recovery wrap. Do not treat the recovery public key as a secret.

### C6. MEDIUM: trust on first use (TOFU) for the account record on devices that joined by approval
- `finish_join` (`lib.rs:721-725`) never sets `recovery_public`. `apply()` then pins whatever the first account record says (`911-919`). iOS `takeWraps` is the same (`CloudSync.swift:367-368`).
- That device's later `revoke()` seals the next epoch's recovery wrap to a server-chosen recovery public key (`lib.rs:792-793`), if the first record it saw was forged (possible via C1 or C4).
- **Fix:** the approving device should hand the recovery public key (and the device list hash) to the new device inside the authenticated approval payload.

### C7. MEDIUM: revocation can leave the revoked device's token working
- `ensure_device` (`lib.rs:537-539`) returns the cached `device_id` without registering. Sign-out keeps `device_id` (`lib.rs:503-513`), so after sign-out and sign-in the **new token is never bound to the device** (`api_tokens.device_id` stays null).
- `DELETE /v1/sync/devices/:id` revokes only tokens with `device_id = id` (`sync.ts:144`), so the thief's or revoked laptop's current token survives revocation. It can still pull ciphertext, revoke other devices, `DELETE /v1/sync`, and start epochs (C1).
- Side effect: `GET /v1/sync/keyrings` joins wraps on `caller.deviceId` (`sync.ts:204-206`). With a null device id, that device can never receive a rotated epoch.
- iOS has the same structure (`CloudSync.swift:393`).
- **Fix:** always (re)bind the token. `POST /v1/sync/devices` with the same public key is already idempotent (`sync.ts:119-127`), so call it on every new token.

### C8. MEDIUM: any account token is all-powerful (no device binding, no re-authentication)
- `sync.ts:133-148`, `302-313`, `151-195`: any `nk_` token, including one that was never approved for sync, can revoke devices, delete everything, start epochs and overwrite wraps.
- Anyone who can receive the account's email OTP can therefore destroy the data, or carry out C1 without touching the server.
- **Fix:** require a token bound to a trusted (approved) device for these routes, and a fresh Supabase re-authentication for `DELETE /v1/sync`. Server-side checks do not stop a malicious server, but they do stop account-level attackers.

### C9. MEDIUM: iOS sign-out then sign-in to another account does not clear the previous account's keys or chats
- `signOut` sets `state.account = nil` (`CloudSync.swift:196`). `finishSignIn` only forgets keys when `state.account` exists and differs (`180-183`), so the switch goes undetected.
- What survives: the old account's keyrings, `deviceId`, `revisions`, `accountRecord`, `recoveryPublic` and decrypted `chats`. `hasKeys` stays true.
- `approve()` under account B then wraps **account A's keyrings** to a device of account B (`277-281`). A's decrypted chats stay visible while signed in as B.
- Rust handles this correctly, because it keeps `account` across sign-out (`lib.rs:483-492`).
- **Fix:** remember the last account id separately, or forget keys and chats on sign-out.

### C10. MEDIUM: iOS `approve` can rewrite the trusted-device list from nothing
- `CloudSync.swift:282`: if `state.accountRecord` is nil, it builds `(state.recoveryPublic ?? "", [])` and pushes a record with only the new device, and possibly an empty `recoveryPublic`. Rust refuses in this case (`lib.rs:756`).
- Other devices with the same pinned key accept it, which drops every other trusted device from the next rotation (DoS). `trustSelf` (`408`) has the same fallback.
- **Fix:** refuse, as Rust does.

### C11. LOW-MEDIUM: the server can crash the iPhone app
- Swift traps on:
  - `UInt32(Int64)` out of range: `currentKeyId` at `CloudSync.swift:211`, `242`, `321`; `keyId` at `356`.
  - `UInt64(rev)` with a negative revision (`360`).
  - `1...current` with `current == 0` (`246`, `323`).
- A malicious server or a man-in-the-middle can put the app in a crash loop.
- Rust truncates instead (`as u32`, `lib.rs:855`, `895`). Harmless, but it is a divergence.
- **Fix:** use `UInt32(exactly:)` and guard `current >= 1`.

### C12. LOW: restore without an account record drops other trusted devices
- `lib.rs:686`: if the server withholds the account record, `restore()` creates a record listing only this device and pushes it. iOS does the same (`408`).
- The other devices are then left out of the next rotation (DoS).
- **Fix:** refuse to push an account record you have not read, or merge with the server's devices only after the user confirms them.

### C13. LOW: OAuth loopback callback is reachable by any local process or web page
- `lib.rs:423-451`. A request to `/callback?error_description=...` sets `last_error` to attacker text and closes the listener (sign-in DoS). Login CSRF is blocked by PKCE.
- Server-supplied `message` strings go to the UI verbatim (`http.rs:462-473`; `CloudSync.swift:532`). A malicious server can show phishing text such as "enter your recovery key at ...".
- **Fix:** add an OAuth `state` parameter checked on callback. Show fixed error strings keyed by error code.

### C14. LOW: Supabase email linking does not check that the email is verified
- `account.ts:45-60` links a Supabase identity to an existing `users` row by email when that row has no `auth_subject` (beta signups, possibly already on a paid plan).
- `supabase.ts:52-56` trusts the `email` claim without checking verification (`user_metadata.email_verified`, `email_confirmed_at`).
- If the Supabase project ever allows unconfirmed sign-ups (password sign-up with "Confirm email" off, or a provider that returns unverified emails), an attacker takes over the pre-provisioned account and its plan. This depends on configuration.
- **Fix:** check `email_verified` or `amr`, or fetch `/auth/v1/user` and require `email_confirmed_at`. Make sure password sign-up is disabled in Supabase.

### C15. INFO: `docs/SYNC-ENCRYPTION.md` is out of date and over-claims
- Line 76 still describes the symmetric recovery wrap; it is ECIES now, 146 bytes.
- Line 61 says the server "can't be shown a forged or rolled-back one", which is false (C1, C3, C4).
- Line 36 says revocation "cuts its sign-in", which is not always true (C7).
- Line 35 implies mutual verification, but the fingerprint is checked one way only.
- The doc does not mention that the id key is never rotated, so object ids stay linkable across epochs and a revoked device can still compute ids for chats it knows.

## Suspicions (not fully verified)

- **S1.** Swift `SoftwareKey(rawRepresentation:)` and Rust `SecretKey::from_slice` must reject the same scalars (0 and ≥ n) for `recoveryAgreementKey`. They probably do (BoringSSL rejects ≥ order), but counter > 0 is not covered by the golden vectors.
- **S2.** Recovery-key parsing differs. Swift uses Unicode `uppercased()` (`SyncCrypto.swift:272`), so "ß" becomes "SS", plus other ligature expansions. Rust uses ASCII uppercase. Swift may accept inputs Rust rejects. Harmless, but a divergence.
- **S3.** Swift `fromBase64url` (`SyncCrypto.swift:376-384`) likely accepts non-canonical trailing bits; Rust's `base64` rejects them. No security impact found, because the AAD uses the string ids, not decoded bytes.
- **S4.** `trustProxy: hop === 0` (`server.ts:30`) is safe only if the app can be reached solely through Fly's proxy. If reached directly, a forged `X-Forwarded-For` bypasses the IP rate limits (sign-in, sync, donations).
- **S5.** Donation unlinkability cannot be judged yet, because no client sends donations. Risks to design out:
  - reusing the shared `reqwest` client or `URLSession.shared` (a reused TLS connection ties a donation to an authenticated session);
  - the identifying User-Agent (`http.rs:478`);
  - IP and timing correlation with sync traffic;
  - Fly edge logs (`logLevel: "silent"` covers only the app);
  - the research key is not yet pinned.

  Use a separate ephemeral client with no connection reuse, a generic User-Agent and random delay, or OHTTP.
- **S6.** The global `bodyLimit: 8 KiB` (`server.ts:30`) makes `PUT /v1/sync/keyrings` fail once there are about 35 devices (each wrap is about 200 base64 characters). Revocation and rotation would then fail closed. This is functional, but it blocks revocation.

## What the server learns (metadata)

- Account email, plan, Supabase subject.
- Device labels, which are often real names ("Philip's MacBook").
- Session labels, token last use (to the hour), device public keys and creation and revocation times.
- Per object: collection name in plaintext (`chat`, and `account`, which identifies the account record), padded size, revision count (edits per chat), exact `updated_at`.
- Chats are whole-transcript records (up to 1 MB), so size growth tracks the conversation as it progresses.
- Object ids stay stable across key epochs (the id key is never rotated).
- `seq` comes from a global sequence (`sync_change_seq`), which leaks other tenants' total write volume to every client.
- Client IPs at request time.

## Checked and believed sound

- **Record sealing** (`record.rs`): a fresh 32-byte salt, so the key and nonce are unique per seal. HKDF output is correct (tested against the `hkdf` crate). The AAD binds account, epoch, collection, object id and revision, with newline separators over validated fields, so there is no ambiguity. Version byte, length checks and unframe bounds are fine. Padmé matches the paper.
- **ECIES** (`wrap.rs`): fresh ephemeral key, both public keys in the HKDF salt, context used as both info and AAD. Points are validated (`from_sec1_bytes`, uncompressed only), and P-256 has prime order, so there is no small-subgroup attack. Wrap context binds account, epoch and device. The only weakness is the missing sender authentication (C1).
- **Recovery key**: 256-bit OS randomness. Crockford encode and decode are correct, including the 3 zero padding bits and the length check. The 16-bit checksum catches typos. P-256 derivation uses rejection sampling over HKDF outputs, so it is unbiased; retries happen with probability about 2^-32. An empty salt is equivalent in Rust (`None`) and Swift (`Data()`).
- **Fingerprint**: 80 bits of SHA-256, so second preimages are infeasible. The problem is how it is used (C2), not its strength.
- **Object ids**: HMAC with a domain-separated label. Chat records are checked against `object_id(id)`, so the server cannot swap chats (`lib.rs:942`; iOS `377`).
- **Swift crypto**: matches Rust byte for byte, including HKDF split, AAD and context strings, frame and unframe, and Data slicing on re-based buffers.
- **JWT verification** (`supabase.ts`): the algorithm list is fixed per mode (HS256 only with a secret, ES256/RS256 only with JWKS), so there is no algorithm confusion. Issuer is exact, audience is `authenticated`, expiry is checked, anonymous users are rejected, and `role` must be `authenticated`. The account takeover in which a different subject claims an email already linked to another subject is blocked (`account.ts:47-50`).
- **Tokens**: 256-bit, stored only as SHA-256, format checked by regex before any database access, 180-day idle expiry, revoked on device revoke (subject to C7).
- **Plan gating**: every write route uses `guard(write=true)`, and the plan is read on every request. Reading and deleting work on any plan, as intended. Quota is enforced in the transaction with an advisory lock.
- **Server push**: requires `revision = have+1` and `keyId = current` under a per-user advisory lock. Input validation is strict (canonical base64url, sizes, UUIDs).
- **Donations**: random 16-byte id and 32-byte delete token, SHA-256 stored, `timingSafeEqual` on equal lengths, no user, device or IP column, created date only, in-memory rate limit, silent log level.
- **Secret storage on the computer**: OS keychain, or a 0600 file written with `create_new`. Keyrings and keys are zeroized in Rust; Swift has no zeroization (info).

## What was done

Design: [decision 0008](../docs/decisions/0008-authenticated-wraps-and-join-codes.md). Tests: `crates/nekko-cloud/tests/attacks.rs` runs attacks through a proxy that rewrites the real API's answers (`cargo test -p nekko-cloud --test attacks` with `NEKKO_CLOUD_ITEST_URL` against `npm run dev:local`); `apps/nekko-agent-api/src/sync.test.ts` and `account.test.ts` for the server; `CloudSyncTests` for the iPhone (macOS CI).

| Finding | Status | Fix | Test |
| --- | --- | --- | --- |
| C1 Unauthenticated wraps | Fixed | Wraps authenticated by the sender's device key (static-static ECDH). A device takes epoch *n+1* only from a device in its epoch-*n* record, one epoch at a time, and only once the new epoch's record lists it. Keyrings are never overwritten; old ones are deleted. Server: epochs and wraps only from a device holding the current keys; wraps never overwritten. | `a_keyring_from_an_untrusted_device_is_refused`; `a_wrap_opens_only_for_its_device_account_epoch_and_sender`; `refuses key, device and data changes from a token without the current keys`; iPhone `testANewEpochIsTakenOnlyFromATrustedDevice` |
| C2 Approval TOCTOU | Fixed | Approval by a typed join code. Its tag must bind the exact key wrapped to, checked in the same call that wraps. | `approval_refuses_a_swapped_key`; `a_join_code_checks_both_sides`; iPhone `testApprovingAComputerChecksItsCode` |
| C3 Rollback guard lowered | Fixed | The guard never goes down; a conflict below what was seen is an error. A replayed old revision is ignored. | `the_rollback_guard_holds`; iPhone `testTamperedSwappedAndRolledBackRecordsAreIgnored` |
| C4 Old epochs usable | Fixed (a, c); limited (b) | Records only under the epoch a device holds; old keyrings deleted; the rotating device seals everything again. A device refuses a server that reports an epoch older than it holds. Hiding a rotation from a device that hasn't seen it is the fork case below. | `a_revoked_device_cannot_write_under_the_old_epoch`; live test checks every chat is under the new epoch after a rotation |
| C5 Forged recovery wrap | Limited | The restoring device checks the epoch's account record names its recovery key and epoch. A removed device colluding with the server can still forge a whole epoch for a restoring device (the recovery wrap has no sender). Open question for the outside review. | `restore_needs_the_accounts_own_record` (partial) |
| C6 TOFU on approved devices | Fixed | The join wrap authenticates the approver to the new device; the new device takes the recovery key's public half from a record sealed under the keyring it got. | `testJoiningByApprovalWithTheJoinCode` (a wrap without the code is refused) |
| C7 Token not rebound | Fixed | Every sign-in rebinds the token to the device (server: same key re-registers idempotently). | `binds a new sign-in's token to the same key, and keeps a join tag` |
| C8 All-powerful tokens | Fixed | Key, device, push and wipe routes need a token bound to a device holding the current keys; wiping without one needs a sign-in from the last 10 minutes. | `refuses key, device and data changes…`; `wipes everything only from a keyed device or right after a fresh sign-in` |
| C9 iPhone account switch | Fixed | The account the keys belong to is kept across sign-out; another account's sign-in forgets keys and chats. | `testAnotherAccountNeverSeesTheFirstAccountsKeysOrChats` |
| C10 iPhone approve rewrites the list | Fixed | No record, no change (as on the computer). | covered by the approval tests |
| C11 iPhone traps on bad numbers | Fixed | `UInt32(exactly:)`, epoch ≥ 1, revision ≥ 1. | `testOutOfRangeNumbersFromTheServerDontCrash` |
| C12 Restore invents a record | Fixed | Restore needs the account's own record. | `restore_needs_the_accounts_own_record`; `testRestoreRefusesToInventAMissingAccountRecord` |
| C13 Loopback callback | Fixed | Fixed wording only; only a code PKCE accepts ends the wait. No `state` parameter: PKCE already binds the code to this sign-in. Our own API's errors (plan, account) are still shown. | — |
| C14 Unverified email links | Fixed | Linking an existing account (and following an email change) needs `email_verified` or a code/link sign-in. | `lets only a proven email claim an existing account` |
| C15 Doc over-claims | Fixed | `docs/SYNC-ENCRYPTION.md` rewritten: trust, wire format, limits stated plainly. | — |
| S2 Unicode parsing | Fixed | Typed codes and recovery keys are ASCII only on both platforms. | `a_join_code_checks_both_sides`; iPhone `testRecoveryKeysCatchTyposAndRoundTrip` |
| S6 8 KiB body limit | Fixed | 256 KiB for starting an epoch. | — |
| S1, S3, S4, S5 | Open | Passed to the outside review (S4: confirm the API is only reachable through Fly's proxy before launch; S5: design donations with a separate client, no session reuse). | — |

**One note on the tests:** after a rotation a device deletes the old keyring, so `a_revoked_device_cannot_write_under_the_old_epoch` passes even with the epoch check removed (checked by mutation). Both defenses are in place; the test proves the behaviour, not that one check.
