# Direct text cloud chats on iPhone

Use a cloud model without pairing or keeping a computer online. These are device-local text conversations, separate from computer chats and Nekko Cloud sync.

## Set up

1. Open **Settings → Models on this iPhone → Add a provider**. Before pairing, the welcome screen also has **Or use a model provider on this iPhone**.
2. Alternatively, open **New chat → Run on → This iPhone**, tap the model chip, then **Add a provider**. The phone is offered before a provider is configured.
3. Choose the provider and paste your own API credential. A Claude/ChatGPT subscription is not an API key.
4. For providers with an address field, replace every placeholder and use the final HTTPS endpoint. Redirects are refused, even to another path on the same host.
5. Add checks the model list, or requests a short streamed test reply for providers without a list. Pick a model, type a message and start the chat.

| Provider | Address / credential |
| --- | --- |
| Claude API | API key; optional Anthropic workspace ID |
| OpenAI | OpenAI API key; models are discovered from the API |
| OpenRouter | OpenRouter key; models are discovered from the API |
| Claude in Amazon Bedrock | Mantle address such as `https://bedrock-mantle.us-east-1.api.aws/anthropic`; short-lived Bedrock token, sent in **x-api-key**, not Authorization. No SigV4/IAM-role login in the phone app. |
| Claude in Microsoft Foundry | `https://YOUR_RESOURCE.services.ai.azure.com/anthropic`; resource key. Deployment names must match the offered model IDs; custom deployment names are not configurable. |
| Claude on Vertex AI | `https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/global`; Google access token with model access (usually expires in about an hour). |
| OpenAI-compatible | Your final HTTPS Chat Completions base URL, usually ending in `/v1`; key optional. Must expose a usable models list and SSE Chat Completions stream. |

Provider credentials and model access can incur charges. Mantle/Foundry/Vertex use a small built-in catalog, not a guarantee that your account or region has access to every model. Sonnet 4.6 is not offered on the Mantle Messages route.

## During a chat

- **Stop** keeps the text received so far. **Try again** replaces the last assistant reply and sends the conversation again; it can incur another charge.
- Model selection affects the next reply. Rename, pin, complete, restore and delete work locally.
- Completed replies need an explicit stream completion marker. A cut-off connection is an error, not a successful answer; received text is kept. Partial replies interrupted by app termination are marked on reopening.
- To replace an expired token: Settings → Models on this iPhone → touch and hold the provider → **New key**. Key rotation, disable and remove stop its active replies and invalidate in-flight discovery/tests.
- **Reload models** retries discovery. A failed Test never succeeds merely because an old model list was cached.

## Privacy and boundaries

Keys stay in this device's Keychain; chat/provider metadata is kept in protected local Application Support outside backups. The configured provider receives your conversation and key over HTTPS. Nothing in a direct chat passes through a computer, the relay or Nekko Cloud. No tools, file access, photo attachments, subscription harnesses, local model servers or chat sync are provided in this mode.

The app refuses credentials in URLs, configured queries/fragments, unsafe model paths/headers and every HTTP redirect. Raw provider error bodies are not saved or displayed because an endpoint can echo a secret. Streams/model lists are bounded and overly large or malformed responses stop with an error rather than silently dropping text.

**Forget everything on this iPhone** removes these local chats, provider metadata and keys alongside other device data. It does not delete records retained by a provider. Persistence uses the existing nonthrowing file/Keychain stores; a platform write failure cannot be reported transactionally by this feature.

## Troubleshooting

- **401 / 403:** replace the credential and verify account/model entitlement. For Mantle, use a Bedrock token, not an AWS access-key ID. For Vertex, check token expiry.
- **404:** check the base path, region/project/resource, and model/deployment ID. Do not paste a complete `/messages` or `/chat/completions` URL as the base.
- **429:** wait for the provider's quota/rate limit to reset.
- **Redirect / connection failure:** configure the final HTTPS base URL, check the network and retry. The app will not forward credentials through a redirect.
- **Stream ended before completion:** the connection closed without `message_stop` or `[DONE]`. Retry deliberately; there is no automatic paid retry.
- **Stream too large / unreadable:** the endpoint did not provide a bounded compatible text SSE response. Try a shorter request or another model/provider.

## Verification status for #2414

Source regression tests cover noncooperative late model-list callbacks after rekey/disable/remove/forget, newer-load ordering, cached-list Test failures, request/auth shapes, persisted URL/header validation, SSE framing/error/completion limits and interrupted/cancelled local chats. Native request/redirect policy tests and deterministic no-computer UI checks are included. They have not yet been executed for this branch: Windows has no Swift on PATH and the installed Docker CLI cannot reach a running Linux engine.

An unchanged native baseline was dispatched at `a45e083f2b932bdbbc6d88dcbb1420dc9b4bfb64`: [Native iOS run 42787871446](https://github.com/nekko-labs/nekko-agent/actions/runs/42787871446). It is queued as of this checkpoint. Follow [draft PR #2462](https://github.com/nekko-labs/nekko-agent/pull/2462) for subsequent test/evidence runs and exact commits. Feature native run: [42789585291](https://github.com/nekko-labs/nekko-agent/actions/runs/42789585291); pinned matched iOS evidence: [42789613355](https://github.com/nekko-labs/nekko-agent/actions/runs/42789613355). Those initial runs target e3273a712; the PR records later source-test updates and their run IDs. Matched before/after screenshots are required for New chat and the empty phone model picker. Media must be inspected before it is described or published as verified.

Not established: final Swift/Xcode type checking, native interaction/visual approval, live paid-provider authentication, physical iPhone/iPad behavior, localization of new copy, or process-death durability if the platform refuses a disk/Keychain write. No real credentials were used. No Android/global docs were changed. The comparison workflow adds recording only for this direct-cloud harness; no permission or runner requirement was changed.

Official API references and the desktop parity sources are recorded in the [iPhone specification](../../../spec/phone/iphone-chats-on-this-iphone-and-group-by-computer.md). The OpenAI API-reference fetch returned HTTP 403 in this environment; its token-cap shape was cross-checked against desktop `openai_compat.rs` and Android `ad7039c52`, not represented as a successfully fetched reference.
