//! Automation for the engine daemon (PF14): the services that act on their
//! own schedule rather than on a click, ported from the TS host. Each keeps
//! its TS file format and is held to the TS code by a golden set the TS
//! writes (`packages/host/src/*.golden.test.ts`).

pub mod json;
pub mod tasks;

pub use tasks::{TaskHost, Tasks};
