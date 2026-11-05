---
status: accepted
date: 2026-11-05
---

# 0052. The iPhone connects to GitHub, Linear and the rest itself, with tokens in its own Keychain

## Context

The desktop has connectors (GitHub, GitLab, Linear, Jira, Floop, Slack and more,
`packages/shared/src/connectors.ts`), with tokens in the computer's OS keystore
(decision [0046](0046-secrets-live-in-the-os-keystore.md)). `connector:connect` and
`connector:disconnect` are in `PHONE_DENIED_FOREVER`
(`packages/shared/src/phone-access.ts`): a phone never puts a credential on a
computer, and never reads one back.

Philip asked (2026-11-05) for a Connectors page on the iPhone, to connect a git
provider (GitHub, GitLab and the other common ones) and project-management tools
(Jira, Linear, Floop), and for a Pull requests screen that lists the selected git
provider's pull requests with one-tap prompts about them. Spec:
[connectors and pull requests on the iPhone](../../spec/phone/iphone-connectors-and-pull-requests.md).

## Options considered

1. **Keep the tokens in the phone's own Keychain, for the phone's own use.** The phone
   calls the service straight over https, as it calls its own model providers
   (decision [0050](0050-the-iphone-runs-chats-on-its-own-cloud-providers.md)). Pull
   requests work with no computer online. Computers keep their own connectors.
2. **Seal the token to a computer** (as decision
   [0016](0016-a-phone-carries-a-sealed-provider-key-and-never-holds-one.md) does for
   provider keys). The phone never holds the token, but needs new host channels, golden
   parity, and a computer online for every pull request list.
3. **Both**: the phone's own, plus an option to seal a copy to a computer. The largest
   scope, and it reopens `PHONE_DENIED_FOREVER` for no need the user named.

## Decision

Option 1, chosen by Philip on 2026-11-05 (`PhoneConnectors`, `ConnectorsModel` in NekkoKit).

- Tokens are a separate Keychain service (`dev.nekkolabs.nekkoagent.phone-connectors`),
  `AfterFirstUnlockThisDeviceOnly`, never synchronized, not in backups. The saved list
  (`this-iphone-connectors/phone-connectors`) holds each connector's kind, its
  non-secret fields (address, email, Trello's API key) and the account name; never a
  token.
- A token is sent only to its own service, over https: an `http://` address is refused,
  and requests go through the same ephemeral, cache-less session as the phone's model
  providers.
- Connect makes a real call first (who the token belongs to) and keeps nothing when the
  service turns it down.
- Kinds: GitHub (and GitHub Enterprise by its API address), GitLab (gitlab.com or a
  self-managed instance), Bitbucket Cloud; Linear, Jira Cloud, Floop, Asana, ClickUp,
  Trello, Todoist.
- One connected git provider is the selected one the Pull requests screen reads.
- `connector:connect` and `connector:disconnect` stay in `PHONE_DENIED_FOREVER`: these
  tokens are never offered to a computer, the relay or Nekko Cloud, and a phone still
  cannot change a computer's connectors.
- Settings → Forget everything on this iPhone deletes these tokens too.

## Consequences

- A lost, unlocked phone can read what these tokens can until they are revoked at the
  service; the Keychain and the app lock protect them, as for the phone's model keys.
  The connect form's hints ask for read scopes.
- A computer and the phone connected to the same service hold separate tokens.
- Android has no connectors yet.
