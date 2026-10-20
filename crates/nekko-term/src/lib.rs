//! Pseudo-terminal sessions for `nekkod`, the Nekko Agent engine daemon.
//!
//! See `session.rs` for the data path and its flow-control rules.

mod ring;
mod session;
mod shells;
mod ssh;
mod tail;
mod utf8;

pub use ring::Ring;
pub use session::{
    BATCH_MAX, CreateSpec, DROP_AFTER, FRAME, HIGH_WATER, RING_CAP, Registry, RegistryEvent, STALL_AFTER, Snapshot,
    StreamMsg, SubHandle, Subscription, TerminalInfo, TerminalViewer, UpdatePatch,
};
pub use shells::{ShellOption, detect_shells, resolve_shell};
pub use ssh::{SshHost, find_ssh, parse_ssh_config, read_ssh_hosts, ssh_shell};
pub use tail::{TAIL_DEFAULT, TAIL_MAX, tail_cut};
pub use utf8::Utf8Carry;
