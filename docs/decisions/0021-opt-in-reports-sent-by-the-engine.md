# 0021: Opt-in usage and crash reports, sent by the engine

Date: 2026-10-24. Status: accepted.

## Context

People who want to help should be able to send anonymous usage and crash reports to PostHog. Nekko Agent promises local-first privacy, so reports must be opt-in, anonymous, scrubbed, and visible in Settings > Connections.

## Decision

- **Off by default.** Asked once in onboarding (skippable) and in Settings. The install id is random and replaced every time reports are turned on.
- **The engine sends everything.** The UI hands events to `telemetry:capture`. The engine keeps an allow-list of events and properties, scrubs every string, batches, and posts to PostHog's `/batch/` through `nekko_net::send("telemetry")`. So the Connections switch, All connections off and the activity log all cover it.
- **No PostHog SDK** in the renderer or main. The renderer's CSP stays closed to outside hosts, and session recording, autocapture, feature flags and surveys never ship.
- **No person profiles, no location lookup**, and the project discards client IPs.

## Alternatives considered

- **posthog-js in the renderer.** Rejected: it needs the CSP opened to PostHog and brings autocapture and recording by default. It would also bypass the engine's switch, log and scrubber.
- **On by default with an opt-out.** Rejected: against the product's privacy promise.

## Consequences

A new event needs an entry in `EVENTS` in `crates/nekkod/src/telemetry.rs` and a row in the spec's table. A crash that kills the process before the next minute's flush is lost; reports are best-effort.
