//! What the desktop app needs from the operating system, moved out of
//! Electron main into the engine daemon (PF14): native dialogs, opening a
//! path or URL with the system, the microphone permission, and the
//! self-updater that replaces electron-updater.
//!
//! Pure where it can be (the release feed, version comparison, which file to
//! download, the install plan) so the decisions are tested against the real
//! published feeds and electron-updater's own answers; the side effects
//! (dialogs, downloads, launching an installer) are thin layers on top.

pub mod dialogs;
pub mod mic;
pub mod semver;
pub mod shell;
pub mod update;
