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
- Test a connection, replace its key, disable or re-enable it, and remove it with confirmation. Disabling, key replacement and removal stop that provider's active replies. Test reads the model list for discoverable APIs; fixed-catalog APIs perform a small billed test reply.
- Read the API's models, or choose from the same fixed Claude catalog as iPhone for Bedrock, Foundry and Vertex. Start a streamed text chat, stop a reply, and retry the last reply without duplicating the user message.
- Save provider metadata and transcripts locally. Interrupted replies become stopped replies after reopening. Forget permanently removes the local transcript, not the provider's remote records. Removing a provider deletes its key but retains read-only transcripts.
- Narrow and folded windows show either the list or conversation. Expanded windows show list plus conversation, respecting a reported vertical hinge. The composer accommodates the software keyboard. Horizontal/tabletop posture uses the existing native ChatColumns split: transcript above the hinge, composer below it. Synthetic hinge interaction tests assert book and tabletop composer bounds. Physical hardware and screenshot pixel review remain unverified.

## Security and boundaries

All direct requests use HTTPS and refuse redirects. Bedrock API keys use `Authorization: Bearer`; Anthropic and Foundry use `x-api-key`; Vertex uses a bearer access token. OpenAI wire APIs use bearer credentials when supplied. Keys never appear in provider metadata, transcripts, logs or request error messages. Error bodies are untrusted and are not echoed into the UI.

Credentials occupy separate slots in the existing AndroidSecureStore, sealed with AES-256-GCM under a non-exportable Android Keystore key. Metadata and transcripts are sealed too. The app already opts out of Android backups and device transfer. Direct chats never use the relay or send credentials to a computer or Nekko Cloud. App lock still gates the app. A rooted/compromised device is outside this boundary.

No tools, photos, files, web access, computer context or cross-device sync are provided by these chats. No dependency is added. A configured provider sees the conversation sent to it and may retain it according to its own policy.

## Acceptance and verification status

Protocol tests cover all seven auth paths, HTTPS validation, request bodies, model filtering and SSE text/error/completion parsing. Store tests cover separated credentials, restart, interruption, stop, disable, key rotation, retry, remove and forget. Native interaction tests exercise the real Compose forms and chat controls with a synthetic HTTP transport and separately verify real Keystore sealing/deletion.

Live paid API calls require the user's provider credentials and are not part of synthetic verification. Physical folding hardware, actual hinge posture transitions, native keyboard/tabletop layouts and screenshot pixel review must not be inferred from JVM tests or screenshot capture. See the Android README's verification handoff for exact commands, captured evidence and remaining limitations.
