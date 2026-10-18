# Nekko Agent for iOS and Android

A native app (Expo, React Native) that does two things:

- **Drives Nekko Agent on your computer** over the end-to-end encrypted relay: chats with Working /
  Needs you badges, new chats on the computer's models and folders, streamed replies, approvals,
  the agent's questions, queued follow-ups, Stop. Guide: [docs/REMOTE.md](../../docs/REMOTE.md).
- **Runs models on the phone** through llama.cpp ([llama.rn](https://github.com/mybigday/llama.rn)):
  a curated list of small GGUF models sized to the phone's memory, downloaded from Hugging Face,
  fully offline once downloaded.

## Layout

```
src/app/            routes (Expo Router): (tabs)/index · models · computers, chat/[id], new, pair
src/lib/            pure TypeScript, unit tested: e2e crypto, relay client, protocol mirror,
                    transcript model, markdown, model catalog
src/services/       app state: computers (pairing + live connection), phone (models + local chats),
                    llama (engine; .web.ts stub), push, storage (Keychain/Keystore + JSON files)
src/chat/           chat screen pieces: one ChatModel, two sources (useRemoteChat / useLocalChat)
src/ui/             theme (desktop palette), kit, icons, Markdown, Nekko
```

The relay protocol and its types live in `packages/shared`. The app imports the **types** only
(tsconfig path, erased at build time); the runtime pieces (crypto, client) are reimplemented here
for Hermes, and `src/lib/*.test.ts` pins them to the shared implementation.

## Run it

```bash
npm install            # from apps/mobile; on Windows run it from PowerShell (see below)
npm run web            # quick UI preview in a browser; on-device models are unavailable there
npm run android        # dev build on an emulator/device (needs Android Studio + SDK)
npm run ios            # macOS + Xcode only
```

On-device models need a development build, not Expo Go (llama.rn is a native module).

**Windows notes.** llama.rn's postinstall downloads its prebuilt libraries with `tar`. Under Git
Bash that resolves to GNU tar, which reads `C:\…` as a remote host and fails; install from
PowerShell, or run `npm run llama:native` afterwards. For a local Android build, map a short drive
letter first (`subst N: <repo>`) so CMake stays under the Windows path limit, and point `JAVA_HOME`
at Android Studio's bundled JDK (`…\Android Studio\jbr`).

## Tests

```bash
npm test               # unit tests (vitest)
npm run typecheck
npm run test:relay     # phone ↔ relay ↔ computer, against a local relay and headless agent
```

`test:relay` needs the root packages built (`npm run build:core`, then host, cli, server and relay).

## Release

EAS project `@nekkodev/nekko-agent` (id in `app.json` → `extra.eas.projectId`; the Expo account is
`nekkodev`, devadmin@nekkolabs.com). Profiles in `eas.json`: `development` (dev client, internal),
`preview` (internal distribution, auto-incremented build number) and `production` (store / TestFlight).
`appId` is `dev.nekkolabs.nekkoagent` on both platforms, matching the desktop bundle id.

```bash
# from apps/mobile, after npm install
npx eas-cli build -p ios --profile production          # signs with the Nekko Labs team (3HM5598S99)
npx eas-cli submit -p ios --latest                     # TestFlight; internal testers need no review
npx eas-cli build -p android --profile preview         # installable APK, EAS-managed keystore
```

The iOS build needs Apple credentials once: either sign in with the Apple ID when the CLI asks, or
point the CLI at the team's App Store Connect API key (`EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`,
`EXPO_ASC_ISSUER_ID`, `EXPO_APPLE_TEAM_ID`, `EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION`) so it
runs non-interactively. Push needs an APNs key and FCM service account on the relay (see
`apps/relay-server/README.md`); the app works without push.
