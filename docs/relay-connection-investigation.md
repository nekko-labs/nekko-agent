# Phone connection investigation — #2098

## Confirmed code defect; incident attribution not confirmed

The iPhone message “Could not reach your computer” can mean either a handshake timeout or a failed send. It alone does not identify a provider, relay outage, sleeping computer, or authentication problem.

The iOS relay's `awaitChallenge` previously armed a new three-second challenge deadline unconditionally. `URLSessionConnection` starts receiving frames separately from its delegate's open callback. If the valid challenge/HELLO or welcome wins that race, a late open callback overwrites the welcome watchdog (or starts one on an already-online socket). Its timer then abandons that connection. Android already protects against this ordering with `helloOn` in `awaitChallenge(afterOpen: true)`.

The fix checks socket identity, stopped state, and handshake progress under the client lock. It does not change timeouts, trust a relay control frame, retry writes, or hide an error. Tests cover a delayed first open callback after HELLO and after welcome, alongside existing missing/forged-challenge tests. Hosted red/green verification is pending; Swift and Docker are not installed on the investigating Windows machine.

## To identify the remaining real-world culprit

At the next failure, record the time, iOS/app version, computer version, Wi-Fi/cellular/VPN state, and whether gomi was asleep or waking. Compare the phone's connection status/route detail with the computer's Remote access status at that time. Redact pairing links, room keys, tokens, and private chat content. Do not re-pair or restart services just to gather evidence: those actions can erase the state being diagnosed.

A bad pairing key, no challenge, no welcome, ping failure, host-offline state and a provider failure are different findings. No production logs or live settings were changed in this investigation.
