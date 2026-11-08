---
title: "Nekko Agent service management"
area: desktop
---

# Nekko Agent service management

User intent: see the Nekko Agent service and its version, restart it safely, and manage updates from the computer or a paired phone. These controls never reboot the operating system.

## In progress, issue #2053

The Settings System service card uses the Electron supervisor for local status and restart, including when the daemon is stopped. Restart requires confirmation and can interrupt chats. Local controls do not depend on phone opt-in. The owner can persist a separate, default-off phone management permission, independent of phone quit permission. Phone access additionally depends on device permissions, authorization and host capabilities.

The service card shows updater state, download progress and errors, allows checking and downloading, and asks for confirmation before installing. An install request is not proof of completion; verify the version after reopening. The Local Web UI explains its supervisor and installation limitations and does not attempt desktop restart or installation from this card. The existing Updates section also offers update controls.

Remote capabilities reflect host support, not authorization or readiness. Phone restart and install acceptance are not completion; reconnect and rediscover status and version. Unsupported supervisors and installation layouts must refuse unsafe actions rather than reboot the computer or terminate an unsupervised daemon.

The iPhone computer page discovers service status over the paired connection. Status requires a known paired device with Read; updater state additionally requires the host opt-in. Changes require Read and Change, the default-off `manageServiceFromPhone` permission, and a fresh signed Change proof. Restart and install additionally use the existing step-up policy when host security is enabled; check and download do not require step-up. The phone cannot enable the host permission. Restart and install require confirmation, and installation also requires a downloaded update. No mutation is automatically replayed after a timeout or disconnect.

Capability discovery describes host support, not permission or readiness. Older hosts can report the service as unsupported; there is no fallback to raw updater or quit commands. Headless or unsupervised restart and install are unsupported. Remote install also refuses interactive administrator and Linux .deb flows, or unsupported installation layouts. These controls never reboot the OS. An offline daemon cannot be remotely started through a dead connection.

Source implementation is in progress under [#2053](https://github.com/nekko-labs/nekko-agent/issues/2053), not a shipped or visually verified claim. The integration checkpoint records focused automated backend and desktop tests with isolated stand-ins. Native iOS build and visual verification, desktop visual verification, physical phone interaction, real packaged installations and live cloud have not been verified for this change. Android parity is a follow-up tracked under #2053 until a separate issue exists.
