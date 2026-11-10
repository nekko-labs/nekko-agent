---
title: Android direct cloud-provider chats
area: phone
---

# Android direct cloud-provider chats

Issue: [#2414](https://github.com/nekko-labs/nekko-agent/issues/2414).

## Intent and implemented behavior

**This phone** is always available from the native Android Chats destination, including first run with no provider or computer. It opens a separate, device-only place for standalone text conversations. Pairing and remote-computer chats remain separate.

- Add Claude API, OpenAI, OpenRouter, Claude in Amazon Bedrock, Claude in Microsoft Foundry, Claude on Vertex AI, or an HTTPS OpenAI-compatible API. Subscription harnesses and local model servers still require a computer.
- Name the provider, supply its HTTPS address and masked API key or access token, and optionally choose an Anthropic workspace. Compatible APIs may omit their key. Placeholder addresses, embedded credentials, query strings, fragments and cleartext endpoints are rejected.
- Test a connection, replace its key, disable or re-enable it, and remove it with confirmation. Disabling, key replacement and removal cancel that provider's active replies, model loads and Test requests. Stale model successes and failures cannot overwrite newer results. Test reads the model list for discoverable APIs; fixed-catalog APIs perform a small billed test reply.
- Read the API's models, or choose from fixed Claude catalogs for Bedrock, Foundry and Vertex. Bedrock's catalog excludes models unavailable through its Mantle Messages endpoint. Foundry custom deployment names are not supported by this picker. Start a streamed text chat, stop a reply, and retry the last reply without duplicating the user message.
- Save provider metadata and transcripts locally. Interrupted replies become stopped replies after reopening. Forget removes the local transcript, not the provider's remote records. Removing a provider deletes its key but retains read-only transcripts. Late callbacks cannot rewrite a forgotten chat or a newer reply attempt.
- Narrow and folded windows show either the list or conversation. Expanded windows show list plus conversation, reserving a gap only for a separating or half-open vertical hinge. Flat, non-separating horizontal and vertical folds must retain visible list, transcript and composer rather than consuming the row width as a gap. The composer accommodates the software keyboard. Horizontal/tabletop posture uses the existing native ChatColumns split: transcript above the hinge, composer below it. Synthetic hinge interaction tests assert book and tabletop composer bounds and wait for displayed conversation text, composer, Send and (when expanded) chat-list controls at each transition, including horizontal-flat, vertical-flat and no-hinge states. Required screenshot regions reject blank pixels independently of the outer container. Physical hardware and screenshot pixel review remain unverified.

## Security and boundaries

All direct requests use HTTPS and refuse redirects. Bedrock Mantle's Anthropic Messages endpoint, Anthropic and Foundry use `x-api-key`; Vertex uses a bearer access token. OpenAI wire APIs use bearer credentials when supplied. Persisted provider metadata is revalidated before attaching credentials, including printable header values and safe URL/model paths. Keys never appear in provider metadata, transcripts, logs or request error messages. Error bodies are untrusted and are not echoed into the UI.

Streaming requires SSE content type and explicit completion (`message_stop` or `[DONE]`), not EOF or OpenAI finish reason alone. Failures are terminal and sanitized. Limits cover lines, frames (1,000,000 characters), aggregate stream (8,000,000 bytes in transport and characters in parser), and reply (2,000,000 characters).

Credentials occupy separate slots in the existing AndroidSecureStore, sealed with AES-256-GCM under a non-exportable Android Keystore key. Metadata and transcripts are sealed too. The app already opts out of Android backups and device transfer. Direct chats never use the relay or send credentials to a computer or Nekko Cloud. App lock still gates the app. A rooted/compromised device is outside this boundary.

Storage writes across slots are not transactional. Storage failures are reported but a failed Forget write cannot guarantee durable deletion. Transcript persistence occurs at reply start and cleanup, not every streamed token; process death can lose partial text.

No tools, photos, files, web access, computer context or cross-device sync are provided by these chats. No dependency is added. A configured provider sees the conversation sent to it and may retain it according to its own policy.

## Acceptance and verification status

Protocol tests cover all seven auth paths, HTTPS and persisted-metadata validation, request bodies, model filtering and SSE text/error/completion/size parsing. Store tests cover separated credentials, restart, interruption, stop, disable, key rotation, retry, remove, forget, stale results, provider-test cancellation and storage failures. Native interaction tests exercise the real Compose forms and chat controls with a synthetic HTTP transport and separately verify real Keystore sealing/deletion.

Live paid API calls require approved provider credentials and are not part of synthetic verification. Physical folding hardware, actual hinge posture transitions, keyboard touch timing and screenshot pixel review must not be inferred from JVM tests or screenshot capture. New direct-provider/chat screens have no before state. See the Android README's verification handoff for exact commands, captured evidence and remaining limitations.

## Unfolding regression (#2463)

Parent inspection found the integrated horizontal-flat screenshot blank below the top bar. Reproduction on the unchanged implementation with stronger content assertions confirmed a persistent layout defect, not merely a capture transition: horizontal hinge bounds were incorrectly used as a vertical pane gap, leaving both content panes zero-width. The Android-only fix filters pane gaps by orientation and separation. Automated visibility and nonblank-region checks do not replace required parent pixel/motion inspection. Refreshed evidence and exact source association are recorded in PR #2463; visual acceptance remains pending.
