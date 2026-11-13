---
status: accepted
date: 2026-11-13
---

# 0092. Google Gemini connects through a guided key flow, not a Google sign-in

## Context

Philip asked for Google to be "an interactive connection: either one button click with
web auth or a wizard if that's not possible" (#2722). ChatGPT and OpenRouter already
connect with one browser sign-in. Gemini took a pasted AI Studio key in a bordered form.

## Options considered

1. **"Sign in with Google" over OAuth.** Gemini's OAuth quickstart only covers an app's
   own Google Cloud project: requests made with a person's token are billed to the
   project that owns the OAuth client (ours), not to the person's account or Google AI
   plan. The `cloud-platform`/generative-language scopes need Google's app verification,
   and Google offers no flow that creates an AI Studio key for another app the way
   OpenRouter's PKCE flow does. This would mean Nekko Labs paying for everyone's Gemini
   usage under a client Google has not approved.
2. **Reuse the Gemini CLI's sign-in** (its Code Assist token, the way Claude plans run
   through an installed Claude Code). Nekko would run a second agent CLI just to reach
   Gemini, with its own terms on third-party use. Too large and too uncertain for this
   change. It stays open as a separate "Gemini subscription" idea.
3. **A guided key flow.** Open AI Studio from one button, bring the key back (picked up
   from the clipboard on the desktop when it has a Gemini key's shape, or pasted), then
   check it and connect without a further press.

## Decision

Option 3, and the same flow for every provider that only offers API keys (OpenAI,
Anthropic, Ollama Cloud, and OpenRouter's "use a key you already have"). Sign-in
providers keep their one-click sign-in.

## Consequences

- Connecting Gemini is open, copy, come back: no form to fill and no Test button.
- The desktop reads the clipboard only after the person opened that provider's key page,
  only while the field is empty, and only uses a value with the provider's key shape.
  A browser tab never reads it without a press.
- If Google ships a key-minting or plan-billed OAuth flow for third-party apps, Gemini
  moves to a sign-in like OpenRouter's.
