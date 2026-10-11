//! `TurnStatsAccumulator` and `attachTurnStats` (packages/shared/src/turn-stats.ts).

use crate::num;
use serde_json::{Map, Value, json};

/// A running total for one turn: feed it every `usage` event, then `finish`.
pub struct TurnStats {
    identity: Map<String, Value>,
    started_at: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    output_ms: f64,
    timed: bool,
    calls: u64,
}

fn n(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

impl TurnStats {
    /// `identity` is `{ providerId, modelId, effort? }`, in that order.
    pub fn new(identity: Map<String, Value>, started_at: f64) -> Self {
        Self {
            identity,
            started_at,
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            output_ms: 0.0,
            timed: false,
            calls: 0,
        }
    }

    /// `add(usage)`: one model call's usage (a `usage` event).
    pub fn add(&mut self, usage: &Value) {
        self.calls += 1;
        self.input += n(usage, "inputTokens");
        self.output += n(usage, "outputTokens");
        self.cache_read += n(usage, "cacheReadTokens");
        self.cache_write += n(usage, "cacheWriteTokens");
        if let Some(ms) = usage.get("outputMs").and_then(Value::as_f64)
            && ms > 0.0
        {
            self.output_ms += ms;
            self.timed = true;
        }
    }

    /// `finish(endedAt, end)`: the stats, or `None` when no model call reported usage.
    pub fn finish(&self, ended_at: f64, steps: Option<&Value>, stop: Option<&Value>) -> Option<Value> {
        if self.calls == 0 {
            return None;
        }
        let mut out = self.identity.clone();
        out.insert("inputTokens".into(), num(self.input));
        out.insert("outputTokens".into(), num(self.output));
        if self.cache_read != 0.0 {
            out.insert("cacheReadTokens".into(), num(self.cache_read));
        }
        if self.cache_write != 0.0 {
            out.insert("cacheWriteTokens".into(), num(self.cache_write));
        }
        if self.timed {
            out.insert("outputMs".into(), num(self.output_ms));
        }
        out.insert("wallMs".into(), num((ended_at - self.started_at).max(0.0)));
        out.insert("calls".into(), json!(self.calls));
        if let Some(s) = steps.filter(|v| !v.is_null()) {
            out.insert("steps".into(), s.clone());
        }
        if let Some(s) = stop.filter(|v| nekko_js::truthy(Some(v))) {
            out.insert("stop".into(), s.clone());
        }
        Some(Value::Object(out))
    }
}

/// `attachTurnStats(messages, fromIndex, stats)`: put the stats on the last
/// assistant message from `from` on; false when the turn has none.
pub fn attach_turn_stats(messages: &mut [Value], from: usize, stats: &Value) -> bool {
    for m in messages.iter_mut().skip(from).rev() {
        if m.get("role").and_then(Value::as_str) == Some("assistant") {
            if let Some(obj) = m.as_object_mut() {
                obj.insert("turnStats".into(), stats.clone());
            }
            return true;
        }
    }
    false
}
