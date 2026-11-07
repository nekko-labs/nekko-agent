## Summary

Add the off-by-default account computer-fleet discovery foundation. This is **not yet phone access to a local model**.

- Reuse encrypted-account trust: live device wrap plus current-epoch proof, not sign-in alone.
- Add account-scoped opaque descriptors, publishing-token-bound 90-second leases, bounded storage, strict revisions and withdrawal.
- Hide advertisements after sign-out, token expiry, missing wraps or key rotation; remove them on device revocation, sync deletion or account deletion.
- Keep routes absent unless `NEKKO_FLEET_ENABLED=1`; no desktop setting is changed and no pairing grant or connection is created.
- Record the trust decision and distinguish implemented registry policy from the unfinished end-to-end feature in `spec/phone/account-synced-computer-fleet.md`.

Closes #2163. Part of #2160 (left open).

## Verification

Windows, isolated `feat/cloud-fleet` worktree, package-local `npm ci`:

| Check | Result |
| --- | --- |
| `npm run typecheck` in `apps/nekko-agent-api` | Passed |
| `npm test` | **117 tests passed across 9 suites**, including 15 fleet request tests |
| `npm run build` | Passed |
| `node scripts/spec-index.mjs --check` | Passed |
| `git diff --check` | Passed |
| `npm audit --omit=dev` | Existing moderate `fast-uri` advisory group; reproduced on unchanged main with `npm audit --omit=dev --package-lock-only`; tracked in #2164 |

The first full-suite run caught the migration table-list assertion missing the new table. It was corrected and the complete suite rerun successfully. Synthetic envelopes exercise server policy, not encryption. No dependencies or lockfiles changed.

No user-visible surface changed, so screenshots are not applicable to this registry-only PR. No user app, model server, production account, or deployment setting was modified.

## Unfinished work / release blockers

**This foundation can land disabled; the full fleet feature must not be presented as ready.** Remaining work is tracked in #2160 and the spec:

- Implement and test encrypted descriptor codecs and anti-tampering/rollback checks on clients.
- Implement explicit desktop sharing independently of transcript-sync consent and wire outbound publishing/heartbeats/withdrawal.
- Authenticate account-trusted phone connections without per-computer pairing, preserve existing access controls and terminate revoked live sessions.
- Add native phone fleet discovery/model selection; verify iOS and Android behavior and collect actual desktop/phone evidence.
- Run a real phone-to-this-Windows-PC local-model request through Cloud; no inference or physical-phone verification has happened.
- Configure production identity/deployment access: public auth config returned `503 sign-in-not-configured`; the local Fly CLI has no access token. Production deployment was not attempted.
- Required external encryption review before broad release is not waived by this PR.
- Resolve the pre-existing dependency audit finding separately in #2164. PGlite request tests are not a concurrency stress test against production PostgreSQL.
