//! The agent's system prompt and per-turn context, ported from the TS host
//! for the agent loop's move into the engine daemon (PF14).
//!
//! - `prompt`: `buildSystemPrompt` (packages/core/src/agent/prompt.ts).
//! - `assemble`: `assembleContext` and `renderContextBlock`
//!   (packages/core/src/context/assembler.ts), the one place a turn's context
//!   gets its provenance records and token counts.
//! - `gather`: what feeds them from disk, from packages/host: guideline files
//!   in the workspace roots, attached files, and memory notes.
//! - `rules`: rule folders and subfolder guides beyond the root files, with
//!   an index for the ones that load on demand (`Session.guidance`).
//!
//! Connector fetches and workspace-index search stay in the TS host until the
//! loop moves; they arrive here as ready snippets.
//!
//! Output must equal the TS host's exactly (the prompt is the model's input,
//! the bundle is what the Context Inspector shows), so strings follow
//! JavaScript's rules through `nekko-js`, and `tests/golden.rs` holds the port
//! to outputs the TS functions wrote.

pub mod assemble;
pub mod gather;
pub mod nodepath;
pub mod prompt;
pub mod rules;

pub use assemble::{AssembleInput, Bundle, Item, assemble, render_block};
pub use gather::{Guideline, MemoryScope, collect_attached, collect_guidelines, list_memory, parse_memory};
pub use prompt::{PromptContext, Workspace, build_system_prompt};
pub use rules::{Guidance, ProjectGuidance, collect_rules, project_guidance};
