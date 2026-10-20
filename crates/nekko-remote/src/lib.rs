//! Phone remote access for the engine daemon (PF14): the relay v2 agent that
//! lets a paired phone drive this machine with no inbound ports, ported from
//! `packages/host/src/relay.ts`, `remote.ts` and `packages/shared/src/remote.ts`
//! / `e2e.ts`.
//!
//! The phone apps (Expo, iOS, Android) and `apps/relay-server` speak this protocol,
//! so it is held to the TS code frame for frame by a golden set the TS writes
//! (`packages/host/src/remote.golden.test.ts`): key derivation, sealed frames,
//! HELLO verdicts, the `remote.json` written across a run of operations, and
//! the agent's exact output for a scripted session.

pub mod agent;
pub mod e2e;
pub mod hello;
pub mod jsobj;
pub mod phone;
pub mod phone_changes;
pub mod phone_thumbs;
pub mod phone_views;
pub mod route;
pub mod service;
pub mod socket;

pub use agent::{AgentCore, Out, PUSH_TEST_CHANNEL, RELAYED_EVENTS};
pub use service::{CHANNELS, Clock, Link, LinkHandle, RemoteService, Verifier, system_clock};
pub use socket::{Dispatcher, Events, RelayAgent, Spawn, agent_url};

/// Every public IPC channel the host's dispatcher serves (`IpcChannels`,
/// written by the golden test); the daemon's internal callbacks (`turn:*`,
/// `loop:*`, ...) are not among them. A paired phone may call only the subset
/// `phone` allows.
pub fn public_channels() -> &'static [String] {
    static LIST: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    LIST.get_or_init(|| serde_json::from_str(include_str!("channels.json")).unwrap_or_default())
}

/// Whether `channel` is a public host channel (see `phone::channel_allowed` for phones).
pub fn is_public(channel: &str) -> bool {
    public_channels().iter().any(|c| c == channel)
}
