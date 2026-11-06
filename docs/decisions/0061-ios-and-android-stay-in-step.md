---
status: accepted
date: 2026-11-02
---

# 0061. iOS and Android stay in step

## Context

The native phone plan was SwiftUI first and Kotlin second
([spec](../../spec/phone/native-phone-implementation-decision.md)). In practice
Android has followed the iPhone feature by feature, and some gaps have no task
at all, such as the Apple Watch glance.

## Decision

Both apps carry the same features, existing and new. An OS feature gets its
counterpart on the other phone when one exists, and stays one-sided only when
none does. Each app follows its own platform's design guidance while keeping
the same themes, mascot, wording and screen order. The rule, its acceptance and
the list of gaps are in
[iOS and Android stay in step](../../spec/phone/ios-and-android-stay-in-step.md).

## Consequences

- One app may still land first, because the two have separate CI and evidence,
  but the PR must record the gap and the other app's task.
- Phone features cost about twice as much to build.
- No shared UI layer: the apps stay native, and shared behaviour stays pinned by
  common test data.
