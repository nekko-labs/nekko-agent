//! Automation for the engine daemon (PF14): the services that act on their
//! own schedule rather than on a click, ported from the TS host. Each keeps
//! its TS file format and is held to the TS code by a golden set the TS
//! writes (`packages/host/src/*.golden.test.ts`).

pub mod json;
pub mod skill_steps;
pub mod tasks;
pub mod templates;
pub mod training;
pub mod workflow_rules;
pub mod workflows;

pub use tasks::{TaskHost, Tasks};
pub use training::{Training, TrainingHost};
pub use workflows::{ShellResult, WorkflowHost, Workflows};
