# 0118. Phones sign in to ChatGPT themselves, with their own refresh token

Date: 2026-11-23. Status: accepted. Issue: #3244.

## Context

The desktop runs chats on a ChatGPT plan through the Codex CLI's public PKCE sign-in. The phones' own chats ("This iPhone", "This phone") could only use an OpenAI API key, so someone paying for ChatGPT also had to buy API credit to chat without a computer. OpenAI replaces a refresh token each time it is used, so two installs must never share one.

## Decision

Each phone signs in to ChatGPT itself (Philip chose this, option B, over borrowing a computer's sign-in):

- The same client, parameters and `http://localhost:1455/auth/callback` redirect as the desktop. While the sign-in is open, the app listens on the phone's loopback interface, port 1455, for that one request, checked against the sign-in's `state`.
- The phone keeps its own tokens as the provider's key (Keychain, Android Keystore) and renews them itself before they run out.
- Chats call the Codex backend's Responses API in the Codex CLI's request shape, and the model list is the plan's own.

## Alternatives not taken

- **Borrow the paired computer's access token** over the encrypted channel. Smaller, and no refresh-token race, but it needs a paired, signed-in computer reachable at least every ten days, which defeats chatting on the phone alone. It can still be added later for people who want one sign-in.
- **Device-code sign-in.** No loopback listener, but OpenAI makes it an account setting the person has to find and turn on; kept as a fallback idea.
- **An embedded web view catching the redirect.** Google sign-in (a common way into ChatGPT) refuses embedded web views.
- **Copying the computer's refresh token to the phone.** Each install would sign the other out at its next refresh.

## Consequences

- The phone needs port 1455 free on its own loopback while signing in; if another app holds it, the form says so.
- Signing out on a computer does not sign the phone out, and the reverse; each is its own session at OpenAI.
- Same caveat as the desktop: OpenAI's terms are written around its own apps. The API key path stays.
