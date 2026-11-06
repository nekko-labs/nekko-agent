//! The agent loop for the engine daemon (PF14), starting with the pieces of
//! packages/core/src/agent that do not talk to a model: repairing an
//! interrupted transcript (`resume.ts`), catching a stream that has collapsed
//! into repetition (`runaway.ts`), and shaping the history a model is sent
//! (`windowHistory` and `asSeenByChatModel` in `loop.ts`). The loop itself
//! follows once the providers (`nekko-agent`) and tools (`nekko-tools`) land.
//!
//! Behavior matches the TS functions exactly; `tests/golden.rs` holds these to
//! outputs the TS functions wrote.

pub mod fit;
pub mod history;
pub mod progress;
pub mod resume;
pub mod run;
pub mod runaway;

pub use fit::is_context_overflow;
pub use history::{
    COMPACTION_PREAMBLE, as_seen_by_chat_model, from_latest_compaction, latest_compaction_index, window_history,
    without_images,
};
pub use progress::LoopDetector;
pub use resume::{INTERRUPTED_NOTE, INTERRUPTED_TOOL_OUTPUT, RESUME_PROMPT, repair_interrupted_history};
pub use run::{
    Cancel, ChatRequest, Chunk, ChunkStream, INTERNET_PAUSED, MAX_NETWORK_STREAM_ATTEMPTS, MAX_STREAM_ATTEMPTS,
    ModelClient, RunOptions, Steering, ToolRunner, YIELDED, is_network_error, is_transient_error, is_yield,
    retry_delay, run_agent,
};
pub use runaway::{RUNAWAY_NOTE, RunawayGuard, RunawayOptions};
