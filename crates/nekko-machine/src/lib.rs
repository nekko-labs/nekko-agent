//! Machine probes for the engine daemon: `gpu:stats`, `system:stats` and
//! `machine:readiness`, ported from the TS host (`gpu.ts`, `system.ts`,
//! `readiness.ts` and core's `evaluateReadiness`). The parsers and the advisor
//! are held to the TS functions by `tests/golden/machine.json`, a frozen
//! record of the deleted TS behaviour.
//!
//! Also the hardware profile (`machine:profile`, `profile.rs`), the decode
//! speeds measured here (`measured.rs`) and the model recommendations made
//! against both (`machine:recommendations`, `recommend.rs`), and whether
//! someone is using the computer (`activity:state`, `activity.rs`), and
//! whether a full-screen app is in front (`activity:fullscreen`, `fullscreen.rs`),
//! and whether memory is running low and which app holds it (`memory:state`,
//! `memory.rs`).

pub mod activity;
pub mod fullscreen;
pub mod measured;
pub mod memory;
pub mod nudges;
pub mod parse;
pub mod probe;
pub mod profile;
pub mod readiness;
pub mod recommend;
pub mod temps;

pub use parse::{GpuDevice, GpuStats};
pub use probe::Machine;
pub use profile::HardwareProfile;
pub use readiness::{MachineFacts, catalog, evaluate};
pub use recommend::{Recommendations, bundled_feed, recommend};

/// A number as a JSON value: whole numbers stay integers (`5`, never `5.0`),
/// `NaN` and the infinities are `null`, and `-0` stays a float.
pub use nekko_js::{js_round, num_signed_zero as num};
