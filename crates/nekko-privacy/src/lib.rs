//! Privacy Shield: control what a chat sends a cloud model.
//!
//! Before a request leaves the computer, every value the chat's [`Policy`]
//! covers (emails, phone numbers, card numbers, government ids, public IPs,
//! secrets, the account name in home-folder paths, and the user's own terms)
//! is swapped for a placeholder like `[PII_EMAIL_1]`. What the model sends
//! back has the real values put back before a tool runs or the transcript is
//! saved, so the agent still works on the real files and the user still reads
//! real names: only the provider sees placeholders.
//!
//! The design and its limits are in
//! `docs/superpowers/specs/2026-10-22-privacy-shield-design.md`.

pub mod detect;
pub mod policy;
pub mod shield;

pub use detect::{Kind, Span, scan};
pub use policy::{Policy, enabled, local_usernames};
pub use shield::{Finding, Restorer, SYSTEM_NOTE, Shield, TOKEN_PREFIX, preview};
