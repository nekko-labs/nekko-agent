//! Keeping one long reply's cost in step with its work (#2491): a checkpoint
//! every so many tool steps, and no second copy of a large tool output the
//! model already has. There is still no tool-step limit (removed on purpose
//! in #270): nothing here stops a reply.
//!
//! Every model call in a reply re-sends the whole transcript, so a run of
//! hundreds of steps, or the same large file read three times, is paid for
//! again on every later call. These keep the cost of a long reply in step
//! with the work it does:
//!
//! - **Checkpoint** ([`CHECKPOINT_EVERY`]): a short user note asks the model
//!   to state what is done and what remains, and to prefer targeted reads.
//!   It does not stop anything.
//! - **Repeated output** ([`Repeats`]): an identical call that returns an
//!   identical output of at least [`REPEAT_MIN_CHARS`] gets a one-line note in
//!   its place instead of the second copy.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// Tool steps between checkpoints in one reply.
pub const CHECKPOINT_EVERY: usize = 40;
/// Outputs shorter than this are repeated as they are: the note saves nothing.
pub const REPEAT_MIN_CHARS: usize = 2_000;

/// The checkpoint note after `steps` tool steps.
pub fn checkpoint_note(steps: usize) -> String {
    format!(
        "Checkpoint: this reply has taken {steps} tool steps. In a sentence or two, note what is done and what remains, then continue only with steps that move the task forward. Prefer targeted reads (a line range, a search) over re-reading whole files, guides or long outputs you already have."
    )
}

/// Large outputs seen in this reply, by call and output.
#[derive(Default)]
pub struct Repeats {
    seen: HashMap<u64, usize>,
}

fn key(call: &Value, output: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    call.get("name").and_then(Value::as_str).unwrap_or("").hash(&mut h);
    call.get("input").map(|i| i.to_string()).unwrap_or_default().hash(&mut h);
    output.hash(&mut h);
    h.finish()
}

impl Repeats {
    /// The result to keep for `call` at `step`: as it is, or, when the same
    /// call already returned this same large output earlier in the reply, a
    /// note pointing back to it. Errors and results carrying anything beyond
    /// text (images) are kept as they are.
    pub fn result(&mut self, call: &Value, step: usize, result: Value) -> Value {
        let Some(obj) = result.as_object() else { return result };
        if obj.get("isError") == Some(&Value::Bool(true))
            || obj.keys().any(|k| !matches!(k.as_str(), "toolCallId" | "output" | "isError"))
        {
            return result;
        }
        let Some(output) = obj.get("output").and_then(Value::as_str) else { return result };
        if output.chars().count() < REPEAT_MIN_CHARS {
            return result;
        }
        let k = key(call, output);
        match self.seen.get(&k) {
            Some(first) => {
                let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                let mut out = obj.clone();
                out.insert(
                    "output".into(),
                    json!(format!(
                        "[Same output as this {name} call returned at step {first} of this reply ({} characters); not repeated. Use that result, or ask for a narrower range if you need part of it.]",
                        output.chars().count()
                    )),
                );
                Value::Object(out)
            }
            None => {
                self.seen.insert(k, step);
                result
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_large_repeat_becomes_a_note_and_small_or_changed_ones_do_not() {
        let mut r = Repeats::default();
        let call = json!({ "name": "read_file", "input": { "path": "AGENTS.md" } });
        let big = "x".repeat(REPEAT_MIN_CHARS);
        let res = |o: &str| json!({ "toolCallId": "c", "output": o });
        assert_eq!(r.result(&call, 1, res(&big)), res(&big));
        let again = r.result(&call, 4, res(&big));
        let note = again["output"].as_str().unwrap();
        assert!(note.starts_with("[Same output as this read_file call returned at step 1"), "{note}");
        // The file changed: a new output is kept.
        let changed = format!("{big}y");
        assert_eq!(r.result(&call, 5, res(&changed)), res(&changed));
        // Small outputs, errors and images pass through.
        assert_eq!(r.result(&call, 6, res("short")), res("short"));
        assert_eq!(r.result(&call, 7, res("short")), res("short"));
        let err = json!({ "toolCallId": "c", "output": big, "isError": true });
        assert_eq!(r.result(&call, 8, err.clone()), err);
        assert_eq!(r.result(&call, 9, err.clone()), err);
        let img = json!({ "toolCallId": "c", "output": big, "images": ["data:"] });
        assert_eq!(r.result(&call, 10, img.clone()), img);
        // Another call with the same output is not a repeat of this one.
        let other = json!({ "name": "read_file", "input": { "path": "README.md" } });
        assert_eq!(r.result(&other, 11, res(&big)), res(&big));
    }
}
