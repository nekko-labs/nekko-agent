//! The engine's services for the daemon, ported from `packages/host/src/engine`
//! one at a time and held to the TS by golden sets the host writes.

pub mod acquire;
pub mod builds;
pub mod capacity;
pub mod catalog;
pub mod download;
pub mod folders;
pub mod gguf;
pub mod gpu_adapters;
pub mod install;
pub mod launch;
pub mod library;
pub mod mlx;
pub mod placement;
pub mod runtimes;
pub mod server;

use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A number as a JSON value: whole numbers stay integers, `NaN` is `null`;
/// `-0` stays a float.
pub use nekko_js::{js_round, num_signed_zero as num};
