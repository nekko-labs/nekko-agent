# Provider-data import: capability review

Reviewed 2026-11-08. Scope: consumer ChatGPT, Claude, and Grok accounts, not arbitrary API-created conversations. [Feature specification](../spec/models/provider-data-import.md); implementation [#2259](https://github.com/nekko-labs/nekko-agent/issues/2259).

## Findings

**Prefer connected-account import, retain export-file import as the secondary route, and report capability honestly per category.** No live account was accessed. No import adapter or parser was built. The absence of a documented route in these sources is not proof that a private partner contract cannot exist.

| Provider | Documented account access reviewed | Documented portable-data route | Still unknown |
| --- | --- | --- | --- |
| ChatGPT | OIDC identity scopes; open-source client plan usage for inference. `profile` supplies available name/picture claims, not personalization. | Eligible accounts can request a ZIP with history and other account data; download requires the requesting account. | Supported consumer-history/memory/custom-instruction read API; exact export category schemas and coverage. |
| Claude | Model APIs and managed-agent infrastructure; Nekko uses unmodified Claude Code for subscriptions. | Export includes chats, projects, memory and account data; original uploaded files are excluded. | Supported consumer-data read integration; exact exported settings/profile schema and memory representation. |
| Grok | Developer API docs describe inference and API management; consumer docs describe viewing history in the product. | Consumer Settings/Data Controls offers data download; privacy portal also accepts requests. | Supported consumer-data read integration; archive schema, completeness and differences between standalone Grok and Grok on X. |

## Sources and what they establish

1. [OpenAI: Sign in with ChatGPT on a website](https://developers.openai.com/siwc/website.md). The identity scope table defines `openid`, `profile` and `email`. `profile` is available identity claims, e.g. name/picture. The page requires a registered client and describes a limited commercial trial. It is not a history/memory API contract.
2. [OpenAI: sign-in documentation map](https://developers.openai.com/siwc.md), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md). The reviewed plan-usage route provides inference. HTTP calls require `store: false`; it does not provide persistent consumer conversation storage. Local Codex threads are a separate concept. Different registrations remain distinct even with the same email.
3. [OpenAI: exporting ChatGPT history and data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data). A ZIP includes chat history and other account data. Export may take up to seven days and the download link expires after 24 hours. The reviewed page excludes self-service export for Business, Enterprise and Healthcare; Edu depends on eligibility/admin configuration. It does not enumerate a stable JSON schema or guarantee every personalization category.
4. [Claude: export your data](https://support.claude.com/en/articles/9450526-export-your-claude-data). Explicitly lists chats, projects, memory and account data, excludes original uploaded files and the saved Personal Finance dashboard. Team/Enterprise personal exports depend on an owner setting; primary owners use an organization export. Signed-in download is required; the link expires after 24 hours and may be single-use.
5. [Claude API overview](https://platform.claude.com/docs/en/api/overview). Describes model access and managed agents with Console/API authorization. The API reference includes managed sessions, memory stores and user profiles; their names alone do not establish access to a consumer's Claude.ai history or memories.
6. [xAI consumer FAQ](https://x.ai/legal/faq). Under data-subject rights, instructs users to download their data in Grok Settings/Data Controls or use the privacy portal. It explicitly separates standalone Grok from Grok on X. It does not specify a stable archive schema or a third-party history-read API.
7. [xAI documentation index](https://docs.x.ai/llms.txt), [general API FAQ](https://docs.x.ai/developers/faq/general.md) and [Grok product FAQ](https://docs.x.ai/grok/faq.md). Reviewed to distinguish API access, consumer accounts and product data. No consumer-history/memory read contract was established. The product FAQ warns users of a third-party app using Grok credentials to revoke/change those credentials; credentials should not be solicited as an import shortcut.

### Retrieval limitations

- `https://help.x.com/en/using-x/about-grok` returned HTTP 403 (challenge page); it was not treated as verified documentation or retried repeatedly.
- An older guessed xAI consumer-FAQ docs URL returned HTTP 404. The official website's consumer FAQ and current documentation index were then used instead.
- Some HTML documentation contains very large navigation sections. OpenAI's documented Markdown twins were fetched for the actual sign-in scope/limitation text.
- No approved partner integration documentation, real export bundle, or provider test account was available in this review. No undocumented endpoint was probed, no credential was read, and no source account was modified.

## Existing Nekko boundaries inspected

- [`crates/nekko-oauth/src/lib.rs`](../crates/nekko-oauth/src/lib.rs): `CHATGPT_SCOPES` is `openid profile email offline_access`; `CLAUDE_APPROVED_CLIENT` is disabled/empty. This is existing behavior, not a proposed authorization expansion.
- [Accounts and switching](../spec/models/accounts-and-switching.md): each provider represents an account; Claude Code credentials are not read/copied/stored by Nekko.
- [Claude policy](../spec/product/claude-policy.md): subscription capabilities are gated. A general plan-feature override is not a newly issued consumer-data OAuth client or data-read permission.

## Implementation handoff

1. Ask each provider for the supported mechanism and authorization to read consumer history, saved memory, compatible settings and profile, separately. Require endpoint/schema, category coverage, stable account/workspace identity and test access; do not pass inference credentials to guessed web endpoints.
2. For the independent export fallback, acquire sanitized current exports or authoritative schema fixtures. Record source/version and category omissions. Tests must cover branches, timestamps, empty accounts, partial data, repeats and malicious archives, not just one hand-written happy path.
3. Use one local staging/review/apply pipeline for both inputs. Keep historical instructions inert, activate personalization only after review, never silently enable synchronization, and make retries/undo safe.
4. Verify direct imports against authorized test accounts and capture isolated UI evidence before claiming support. File-import success must not be marketed as connected-account import.

**Checkpoint outcome:** evidence and requirements are ready to review; the requested feature is not shipped. The blockers are supported direct-data access and verified export format fixtures, not a need to re-decide account-first versus file-first.
