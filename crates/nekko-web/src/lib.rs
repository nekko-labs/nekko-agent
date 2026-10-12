//! What the agent reaches outside the workspace with, for the engine daemon
//! (PF14): `fetch_url` ([`fetch`]), ported from the TS host and held to it by
//! golden files the TS functions write (`tests/golden`).

pub mod fetch;

pub use fetch::{FetchedPage, describe_fetched, fetch_url, html_to_text};
