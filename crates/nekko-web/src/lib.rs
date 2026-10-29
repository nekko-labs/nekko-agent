//! What the agent reaches outside the workspace with, for the engine daemon
//! (PF14): `fetch_url` ([`fetch`]), ported from the TS host and held to it by
//! golden files the TS functions write (`tests/golden`).

pub mod browser;
pub mod cdp;
pub mod fetch;
pub mod netguard;

pub use fetch::{FetchError, FetchedPage, describe_fetched, fetch_url, html_to_text};
