# 0025: Retire Expo in favor of native phone apps

Status: accepted

## Decision

Remove the Expo/React Native app, its EAS configuration, dependencies, assets and
dedicated Mobile CI workflow. Native SwiftUI iOS and Kotlin/Jetpack Compose Android
are the supported phone clients. Do not retain Expo pending complete native parity.

## Consequences

Native feature gaps, physical-device verification and store release requirements
remain tracked in the native specifications. Removing Expo does not implement them.
Shared relay, cryptography, push infrastructure, Local Web UI and native CI stay
intact. Remove the retired workflow from merge-gate accounting so stale Expo runs
cannot block unrelated changes. Desktop icon generation must not recreate Expo assets.
Native protocol fixtures and relay integration tests remain with their native apps.
