# What the iPhone app has that Android lacks (2026-11-07)

Follows [the 2026-10-30 report](android-ios-parity-2026-10-30.md). Of that list,
everything has landed on Android except push (AN-6), Nekko Cloud machines and
voice; Markdown tables, Mermaid in chats, link previews and the Markdown composer
are on Android too.

Method: listed the 416 commits on `main` since 2026-10-30, kept those that touch
`apps/ios` and not `apps/android`, then checked each one's feature against the
Android code on `main` (3878cf543) by reading and grepping it. A commit that
looks iOS-only can still have shipped on both (#2023's Run settings arrived with
#2025), so every row was checked in the code. Nothing was run on a device.

## Gaps

| # | Gap | iOS PRs | Android today | Size | Issue |
|---|---|---|---|---|---|
| 1 | Computer settings and safe service management | #2057 | None | M | #2059 |
| 2 | Watching and Done groups, PR status on rows, collapsible groups with activity in headers | #1838, #1918 | Only a Needs you group | M | #2107 |
| 3 | One chat list across every computer, where each chat runs, chats on this phone, group by computer | #1665, #1741 | Connected to all (#1799), but one computer's list at a time | M | #2108 |
| 4 | Connectors page (git providers, project tools, pull requests) | #1783 | None | M-L | #2109 |
| 5 | Hands-free voice conversations and always-on dictation | #1802 | One clip per tap | L | #2110 |
| 6 | Full-screen photos with save, copy, share; previews before and after sending | #1780, #1879 | No photo viewer | M | #2111 |
| 7 | Draft photos durable at once | #2044 | Not yet | S | #2043 |
| 8 | Turn metrics and a completion checkmark | #1911 | Step count and duration only | S-M | #2112 |
| 9 | All, Cloud and Local tabs in the model picker | #1777 | No tabs | S | #2113 |
| 10 | Usage by computer and by this phone, grouped by subscription | #1785 | One computer's totals | S-M | #2114 |
| 11 | Plan sheet behind the composer | #1475, #1603 | None | M | #2115 |
| 12 | Live card: chats as chips that open the chat | #1990 | Focused chat and actions only | S-M | #2116 |
| 13 | Simple/Detailed in the menus, chat-title mascot, pull-up refresh | #1840, #1779 | Mode in the pill; no mascot or pull-up | S | #2117 |
| 14 | Dark launcher icon and Spooky seasonal icon | #2044 | Neither | S | #2118 |
| 15 | Say when Nekko Cloud is unreachable while pairing or connecting | #1446 | Can sit on Connecting | S | #2119 |
| 16 | Pixel build-up before unlocking | #1836, #1905 | Biometric lock without the opening | S | #2120 |
| 17 | Always allow an MCP tool from the notification and the live card | #2066 (open) | Allowed in the chat only | S | #2065 |
| — | Push (FCM) | APNs | None; waits for the Firebase project and the relay's credentials | M | #2121 |
| — | Nekko Cloud machines | Cloud views | None; deferred on 2026-10-30 | L | #2122 |
| — | Apple Watch | Watch app | Wear OS needs a product decision | — | #2123 |

Left out on purpose: the composer's keyboard dismiss button (Android has Back).

## Suggested order

1. Small and already tracked: 7, 17, 9, 15, 14.
2. Chat list: 2, then 3.
3. A chat's working view: 8, 11, 6, 13.
4. The computer: 1, 10.
5. Large: 4, 5; push once the credentials arrive.

## Why the gap reopened

Several iOS PRs since 2026-10-30 neither filed the Android issue nor added a row
to [the gaps table](../spec/phone/ios-and-android-stay-in-step.md), although the
rule in AGENTS.md asks for both.
