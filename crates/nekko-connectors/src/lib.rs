//! Connectors and workflow actions for the engine daemon (PF14), ported from
//! `packages/core/src/connectors`: the reads (`fetch`) that feed chat context
//! and the Connectors page, the polls workflow listeners run, and the action
//! runners workflow steps call. Every request and result matches the TS code
//! (held to it by `packages/core/src/connectors/connectors.golden.test.ts`).

pub mod actions;
pub mod connectors;
pub mod github;
pub mod http;
pub mod js;

pub use actions::{Outcome, render_template, run_action, template_context};
pub use connectors::{can_poll, fetch, poll, snippets};
pub use http::{Http, Net, Request, Response};
