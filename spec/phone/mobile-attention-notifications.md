---
title: Mobile attention notifications and authoritative badges
area: phone
---

# Mobile attention notifications and authoritative badges

Tracks #1875. A badge counts **distinct chats currently awaiting an approval or an answer**, not unread replies, notification deliveries, requests within one chat, or Live Activity rows. Opening a chat is not answering it.

## Implemented

### Authoritative computer state

The daemon reads the complete `chat:pending` map independently of session-summary or Live Activity clipping. Resolving the newest request preserves older outstanding approvals/questions. The relay socket publishes:

```json
{ "type": "attention-unknown" }
{ "type": "attention-snapshot", "tags": ["opaque-chat-tag"] }
```

- Every connection starts unknown and reads a full snapshot. An empty successful map is a known zero.
- Relevant input events cancel stale reads and schedule a replacement. Queued events win over already-ready reads. Reconnects cannot publish an old socket's snapshot.
- Reads time out after five seconds. Failure, malformed data, overflow or an upstream broadcast gap withdraws authority rather than inventing zero.
- A full reconciliation runs every 30 seconds to recover missed changes and deletion/archive effects present in the authoritative map.
- Resolving one of several inputs is not a chat-wide dismissal. Production socket delivery holds legacy dismiss controls until a fresh snapshot proves no input remains. Core-only golden fixtures retain legacy frames for compatibility; they do not represent the socket's final emission policy.
- Tags are the existing first 32 hexadecimal SHA-256 characters of `nekko-activity:<session id>`. Snapshots expose no chat titles, prompts, tool names, arguments or transcripts.

### Relay/APNs

The relay retains bounded pending tag sets per room (maximum 4,096 tags), with an explicit known/unknown state. Only a complete snapshot establishes authority; event deltas alone cannot reconstruct a total after restart. Disconnect, dropped frames and overflow invalidate authority. Registered offline rooms remain bounded by `maxRooms`; disappearance is not proof of zero.

An iPhone registers the complete contributing-room manifest with its push token:

```json
{
  "type": "register-push",
  "deviceId": "welcomed-device",
  "platform": "ios",
  "token": "apns-token",
  "badgeRooms": ["room-a", "room-b"]
}
```

`badgeRooms` is at most 64 unique, non-empty room IDs (at most 256 characters each), never a caller-supplied count. Omitted or malformed manifests withdraw authority. All registrations sharing the token and actual APNs topic must agree. Every listed room must be registered and known. Duplicate registrations/tags in one room count once; equal tags in different rooms are distinct chats. A room opting out of needs-you notifications cannot silently contribute a subtotal. An explicit empty manifest can clear zero.

APNs alerts and dismissals carry an absolute `aps.badge` only when authoritative. Badge-only updates use an alert-class APNs envelope without a banner or sound; sends are serialized per target to preserve ordering. Explicit test notifications never alter badges. Ordinary title/body text is replaced with content-free generic text. Live Activity privacy settings are unchanged.

Ordinary alerts are suppressed per welcomed, connected device—not because another phone or an unidentified socket is connected. Dismissals and badge reconciliation still reach connected iPhones because a suspended socket may linger.

### Native iOS (client layer)

This integration belongs to the follow-up client PR in the #1875 stack; the host/relay layer alone does not supply it.

See [native iOS](native-ios-app.md). Active and fleet computer pending states form the local whole-app count. Startup, incomplete reads and disconnected computers are unknown. Input resolution invalidates local authority and starts a bounded active/fleet read; retained needs-you rows and notification removals wait for an accepted snapshot. Stale reads cannot resurrect answered inputs.

Needs-you alerts can present while an unrelated screen is foregrounded. Preferences, system permission, content privacy and sound settings apply. A serialized writer updates/clears the badge from the latest known total. APNs arrivals withdraw local authority before reconciliation, avoiding a queued stale local total overriding a newer remote badge.

Registrations send the full manifest only when every paired computer uses the same canonical relay endpoint. Mixed independent relays deliberately omit authority rather than presenting a partial count. Local aggregation can still work when every paired computer is known.

### Native Android

See [native Android](native-android-app.md). The active computer's distinct, visible top-level waiting chats produce one persistent notification each with `number = 1`. Replies and connection cards do not contribute. Existing reply channels are migrated because Android channel badge eligibility is immutable after creation. Opening a chat does not auto-cancel attention. Resolution waits for a bounded full pending read; failures preserve unknown state and existing notices. Preferences and runtime notification permission apply.

Android launchers own presentation: some display a number, others a dot, and users can disable badges. This does not promise a numeric icon count on every launcher.

## Verification and limitations

Implemented regression coverage includes real Rust WebSockets for reconnects, ready-read races, duplicate/overlapping requests, five-second timeout and 30-second reconciliation; relay/APNs payload tests for manifests, multiple rooms, ordering, permissions and privacy; Swift package state/registration/persistence tests; Android JVM and isolated native notification/permission tests.

Native iOS SDK tests and inspected matching before/after media are required before claiming visual verification. Recorder-backed notification fixtures do not prove APNs delivery or SpringBoard appearance. Signed physical-device push/background delivery has not been exercised here.

- APNs credentials/topic configuration and notification permission remain deployment prerequisites. No credentials were added or changed.
- Native Android has no FCM token registration. Killed-process delivery is not implemented; current alerts depend on the live connection and reconnect catch-up. Android currently counts the active computer, not every paired computer.
- Independent relay endpoints/workers cannot aggregate a common app-wide target without shared state. Missing room registrations, partial manifests, legacy hosts and relay restart leave the badge unchanged until complete state returns; they never emit a known subtotal.
- APNs delivery is external and not guaranteed, even after a sender accepts a request. Native dismissal callbacks also depend on iOS execution opportunities.
- Local Forget is not remote token revocation. Use Sign out this phone to remove trust/push registration on the host. The final offline-forget/revocation case remains an existing lifecycle limitation; this feature must not describe it as reliable remote cleanup.

## Acceptance

1. Repeated attention events for one chat still count one.
2. Answering the newest of several pending requests does not remove the chat until all are answered.
3. Remote answers and successful reconnect snapshots reconcile a correct zero.
4. Opening a chat does not change pending state.
5. Unknown or incomplete state never replaces a badge with zero or a partial total.
6. Privacy/preferences/permission apply to notifications and badge writes.
7. Native screenshots and tests are reported separately from physical push delivery and launcher-specific limits.
