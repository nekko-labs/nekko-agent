//! What a Claude model takes, read off its id: the context window, the
//! effort ladder, and whether it still accepts a sampling temperature.
//!
//! Ports of `model-capabilities.ts` (shared) and the sampling rules in
//! `anthropic.ts`. The two TS files parse the id with slightly different
//! patterns, and the port keeps both as they are rather than unifying them:
//! `claude-opus-4-20250514` reads as 4.0 for the context window and the effort
//! ladder, but as "4.20250514" (so: no temperature) for sampling. A wrong
//! sampling guess costs one retry, which the learned-shape memory then
//! remembers, so that rule is forgiving by design.

use crate::js;
use crate::types::EffortLevel;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Opus,
    Sonnet,
    Haiku,
    Fable,
    Mythos,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClaudeId {
    pub family: Family,
    pub major: f64,
    pub minor: f64,
}

/// `id.toLowerCase().trim().replace(/^.*\//, '')`: the id with any gateway
/// prefix (`anthropic/claude-opus-5`) removed. A regex `.` stops at a line
/// terminator, so only a slash on the first line counts.
pub fn normalize_model_id(model: &str) -> String {
    let id = js::trim(&model.to_lowercase()).to_string();
    let first_line = id.find(js::is_line_terminator).unwrap_or(id.len());
    match id[..first_line].rfind('/') {
        Some(slash) => id[slash + 1..].to_string(),
        None => id,
    }
}

fn family_prefix(id: &str) -> Option<(Family, &str)> {
    let rest = id.strip_prefix("claude-")?;
    for (name, family) in [
        ("opus-", Family::Opus),
        ("sonnet-", Family::Sonnet),
        ("haiku-", Family::Haiku),
        ("fable-", Family::Fable),
        ("mythos-", Family::Mythos),
    ] {
        if let Some(r) = rest.strip_prefix(name) {
            return Some((family, r));
        }
    }
    None
}

fn leading_digits(s: &str) -> &str {
    &s[..s.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(s.len())]
}

fn digits_value(d: &str) -> f64 {
    d.parse::<f64>().unwrap_or(0.0)
}

/// `parseClaudeModel`: `^claude-(family)-(\d+)(?:-(\d{1,2})(?!\d))?`. A minor
/// of three or more digits (a date) is not a minor at all.
pub fn parse_claude_model(model: &str) -> Option<ClaudeId> {
    let id = normalize_model_id(model);
    let (family, rest) = family_prefix(&id)?;
    let major = leading_digits(rest);
    if major.is_empty() {
        return None;
    }
    let after = &rest[major.len()..];
    let minor = after.strip_prefix('-').map(leading_digits).filter(|m| (1..=2).contains(&m.len())).unwrap_or("");
    Some(ClaudeId { family, major: digits_value(major), minor: digits_value(minor) })
}

fn at_least(c: &ClaudeId, major: f64, minor: f64) -> bool {
    c.major > major || (c.major == major && c.minor >= minor)
}

/// A Claude model's context window, or `None` when the id is not Claude.
pub fn claude_context_window(model: &str) -> Option<u64> {
    let c = parse_claude_model(model)?;
    Some(match c.family {
        Family::Fable | Family::Mythos => 1_000_000,
        Family::Haiku if c.major >= 5.0 => 1_000_000,
        Family::Haiku => 200_000,
        _ if at_least(&c, 4.0, 6.0) => 1_000_000,
        _ => 200_000,
    })
}

/// `claudeMaxOutputTokens`: the most output tokens one reply from a Claude
/// model may hold, by family and generation. `max_tokens` is required on every
/// request, so a chat with no cap of its own is sent the model's own ceiling.
/// An id that is not Claude's gets a generous middle value; a model that holds
/// less says so in a 400 (see `output_limit_error`).
pub fn claude_max_output_tokens(model: &str) -> u64 {
    let Some(c) = parse_claude_model(model) else { return 32_000 };
    if c.family == Family::Haiku && c.major >= 5.0 {
        return 128_000;
    }
    if matches!(c.family, Family::Fable | Family::Mythos) || c.major >= 5.0 {
        return 64_000;
    }
    match c.family {
        Family::Haiku => {
            if c.major >= 4.0 {
                64_000
            } else if c.minor >= 5.0 {
                8_192
            } else {
                4_096
            }
        }
        Family::Sonnet => {
            if c.major >= 4.0 || at_least(&c, 3.0, 7.0) {
                64_000
            } else {
                8_192
            }
        }
        // Opus: 3 held 4k, 4 and 4.1 hold 32k, 4.5 onwards 64k.
        _ => {
            if c.major < 4.0 {
                4_096
            } else if at_least(&c, 4.0, 5.0) {
                64_000
            } else {
                32_000
            }
        }
    }
}

/// `outputLimitError`: the ceiling a 400 about `max_tokens` names, as in
/// "max_tokens: 64000 > 32000, which is the maximum allowed number of output
/// tokens for claude-opus-4-1". `/max_tokens[^.]*?>\s*(\d[\d,_]*)/i`.
pub fn output_limit_error(status: u16, body: &str) -> Option<u64> {
    if status != 400 {
        return None;
    }
    let lower = body.to_lowercase();
    let start = lower.find("max_tokens")?;
    let tail = &body[start..];
    // `[^.]*?>`: the first `>` before the next full stop.
    let gt = tail.find('>')?;
    if tail[..gt].contains('.') {
        return None;
    }
    let digits: String = tail[gt + 1..]
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == ',' || *ch == '_')
        .filter(|ch| ch.is_ascii_digit())
        .collect();
    let limit = digits.parse::<u64>().ok()?;
    (limit > 0).then_some(limit)
}

/// Steered by `output_config.effort` rather than a temperature.
pub fn uses_native_effort(model: &str) -> bool {
    match parse_claude_model(model) {
        None => false,
        Some(c) => match c.family {
            Family::Fable | Family::Mythos => true,
            _ => at_least(&c, 4.0, 7.0),
        },
    }
}

const TEMPERATURE_LEVELS: &[EffortLevel] = &[EffortLevel::Low, EffortLevel::Normal, EffortLevel::High];
const CLAUDE_LEVELS: &[EffortLevel] =
    &[EffortLevel::Low, EffortLevel::Medium, EffortLevel::High, EffortLevel::Xhigh, EffortLevel::Max];

/// The effort levels a model offers, lowest first.
pub fn model_effort_levels(model: &str) -> &'static [EffortLevel] {
    if uses_native_effort(model) { CLAUDE_LEVELS } else { TEMPERATURE_LEVELS }
}

/// The rung a model runs at when no effort is sent: `high`, except Opus 5.5
/// onwards at `medium`.
pub fn model_default_effort(model: &str) -> EffortLevel {
    if !uses_native_effort(model) {
        return EffortLevel::Normal;
    }
    match parse_claude_model(model) {
        Some(c) if c.family == Family::Opus && at_least(&c, 5.0, 5.0) => EffortLevel::Medium,
        _ => EffortLevel::High,
    }
}

/// `isOpenAIReasoning` (model-capabilities.ts): OpenAI's reasoning ids,
/// `/(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)/i`.
pub fn is_openai_reasoning(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    let b = m.as_bytes();
    let ends_ok = |i: usize, extra: &[u8]| i == b.len() || extra.contains(&b[i]);
    (0..b.len()).any(|i| {
        if i > 0 && !b"-_/ .".contains(&b[i - 1]) {
            return false;
        }
        let r = &b[i..];
        if r.len() >= 2 && r[0] == b'o' && b"134".contains(&r[1]) && ends_ok(i + 2, b"-") {
            return true;
        }
        if r.starts_with(b"gpt-oss") || r.starts_with(b"codex") {
            return true;
        }
        if r.starts_with(b"gpt") {
            let at = if r.get(3) == Some(&b'-') { 4 } else { 3 };
            let digits = r[at.min(r.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
            let first = r.get(at).copied().unwrap_or(0);
            if (digits >= 2 || (digits == 1 && (b'5'..=b'9').contains(&first))) && ends_ok(i + at + digits, b".-") {
                return true;
            }
            // `gpt-?` may also skip the dash: `gpt` then the digits right after it.
            if at == 4 {
                return false;
            }
        }
        false
    })
}

/// The saved effort setting, as this model can actually honour it
/// (`effectiveEffort`, model-capabilities.ts).
pub fn effective_effort(setting: Option<EffortLevel>, model: &str) -> EffortLevel {
    let level = setting.unwrap_or(EffortLevel::Normal);
    if uses_native_effort(model) {
        return if level == EffortLevel::Normal { model_default_effort(model) } else { level };
    }
    if is_openai_reasoning(model) {
        return match level {
            EffortLevel::Xhigh | EffortLevel::Max => EffortLevel::High,
            l => l,
        };
    }
    match level {
        EffortLevel::Medium => EffortLevel::Normal,
        EffortLevel::Xhigh | EffortLevel::Max => EffortLevel::High,
        l => l,
    }
}

/// The rung the Anthropic provider sends (`anthropicEffort`). A rung the
/// model does not have is never sent: a model that reached the effort shape
/// only by retry falls back to `high` rather than a 400 on `xhigh`.
pub fn anthropic_effort(model: &str, setting: Option<EffortLevel>) -> EffortLevel {
    let level = effective_effort(setting, model);
    if model_effort_levels(model).contains(&level) && level != EffortLevel::Normal {
        return level;
    }
    if level == EffortLevel::Low { EffortLevel::Low } else { EffortLevel::High }
}

/// Which sampling knob a request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SamplingShape {
    Temperature,
    Effort,
    /// No sampling parameter at all: the shape that cannot be wrong.
    Neither,
}

/// What the API has told us about each model's sampling support.
///
/// The version rule is a guess, and a wrong guess is a 400 that costs the user
/// a turn. So a rejection is information: the request is retried the other
/// way and the shape that worked is remembered for the model, process-wide as
/// in TS (`LEARNED_SHAPE`). Tests use their own memory.
#[derive(Debug, Default)]
pub struct SamplingMemory {
    shapes: Mutex<HashMap<String, SamplingShape>>,
    /// `LEARNED_OUTPUT_LIMIT`: the output ceiling the API reported for a model
    /// when the table below was too generous.
    output_limits: Mutex<HashMap<String, u64>>,
}

impl SamplingMemory {
    pub fn global() -> Arc<SamplingMemory> {
        static GLOBAL: LazyLock<Arc<SamplingMemory>> = LazyLock::new(Default::default);
        GLOBAL.clone()
    }

    fn get(&self, model: &str) -> Option<SamplingShape> {
        self.shapes.lock().unwrap_or_else(|e| e.into_inner()).get(&normalize_model_id(model)).copied()
    }

    /// Remember the shape a request actually succeeded with.
    pub fn learn(&self, model: &str, shape: SamplingShape) {
        self.shapes.lock().unwrap_or_else(|e| e.into_inner()).insert(normalize_model_id(model), shape);
    }

    pub fn reset(&self) {
        self.shapes.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.output_limits.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// `learnOutputLimit`: keep the ceiling a 400 named for this model.
    pub fn learn_output_limit(&self, model: &str, limit: u64) {
        self.output_limits.lock().unwrap_or_else(|e| e.into_inner()).insert(normalize_model_id(model), limit);
    }

    /// `outputCapFor`: the `max_tokens` to send. The request's own cap when it
    /// has one (a sideband call's explicit budget), else the model's ceiling,
    /// never above what the API has told us.
    pub fn output_cap_for(&self, model: &str, requested: Option<u64>) -> u64 {
        let learned =
            self.output_limits.lock().unwrap_or_else(|e| e.into_inner()).get(&normalize_model_id(model)).copied();
        let ceiling = learned.unwrap_or_else(|| claude_max_output_tokens(model));
        match requested {
            Some(n) if n > 0 => n.min(ceiling),
            _ => ceiling,
        }
    }

    /// `rejectsSampling`: what we learned, else the version rule, which is
    /// `^claude-(family)-(\d+)(?:-(\d+))?` with any number of minor digits.
    pub fn rejects_sampling(&self, model: &str) -> bool {
        if let Some(learned) = self.get(model) {
            return learned != SamplingShape::Temperature;
        }
        let id = normalize_model_id(model);
        let Some((family, rest)) = family_prefix(&id) else { return false };
        let major = leading_digits(rest);
        if major.is_empty() {
            return false;
        }
        if matches!(family, Family::Fable | Family::Mythos) {
            return true;
        }
        let minor = rest[major.len()..].strip_prefix('-').map(leading_digits).unwrap_or("");
        let (major, minor) = (digits_value(major), digits_value(minor));
        major > 4.0 || (major == 4.0 && minor >= 7.0)
    }

    /// The shape to open with.
    pub fn first_shape(&self, model: &str) -> SamplingShape {
        self.get(model).unwrap_or(if self.rejects_sampling(model) {
            SamplingShape::Effort
        } else {
            SamplingShape::Temperature
        })
    }
}

/// The next shape after `shape` was rejected, or `None` when all have been.
/// `Neither` is always last: it gives up the effort setting.
pub fn next_sampling_shape(shape: SamplingShape, tried: &[SamplingShape]) -> Option<SamplingShape> {
    let order = if shape == SamplingShape::Temperature {
        [SamplingShape::Effort, SamplingShape::Neither]
    } else {
        [SamplingShape::Temperature, SamplingShape::Neither]
    };
    order.into_iter().find(|s| *s != shape && !tried.contains(s))
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `/`?(names)`?[^.]*\b(words)/` searched anywhere in `text`: one of `names`,
/// then, before the next full stop, one of `words` starting on a word boundary.
fn names_then_word(text: &str, names: &[&str], words: &[&str]) -> bool {
    let b = text.as_bytes();
    for name in names {
        for (at, _) in text.match_indices(name) {
            let mut j = at + name.len();
            loop {
                // `\b` before a word that starts with a letter: the byte before
                // must not be a word character (non-ASCII bytes never are).
                if !is_word_byte(b[j - 1]) && words.iter().any(|w| b[j..].starts_with(w.as_bytes())) {
                    return true;
                }
                if j >= b.len() || b[j] == b'.' {
                    break;
                }
                j += 1;
            }
        }
    }
    false
}

/// Is this 400 about the sampling parameter we chose? Matched on parameter
/// names, which are the contract, not on Anthropic's wording.
pub fn sampling_param_error(status: u16, body: &str) -> Option<SamplingShape> {
    if status != 400 {
        return None;
    }
    let text = body.to_lowercase();
    if names_then_word(
        &text,
        &["temperature", "top_p", "top_k"],
        &["deprecat", "unsupported", "not supported", "unexpected", "remov"],
    ) {
        return Some(SamplingShape::Temperature);
    }
    if names_then_word(
        &text,
        &["output_config", "effort"],
        &["unsupported", "not supported", "unexpected", "invalid", "unrecognized"],
    ) {
        return Some(SamplingShape::Effort);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_reasoning_ids_match_the_ts_pattern() {
        // V8's answers for `/(?:^|[-_/ .])(?:o[134](?:-|$)|gpt-?(?:[5-9]|\d{2,})(?:[.\-]|$)|gpt-oss|codex)/i`.
        let cases = [
            ("gpt-5", true),
            ("gpt5.1", true),
            ("gpt-4.1", false),
            ("gpt-4o", false),
            ("o3", true),
            ("o3-mini", true),
            ("o1x", false),
            ("openai/gpt-5-codex", true),
            ("gpt-oss-120b", true),
            ("my-codex", true),
            ("GPT-10", true),
            ("gpt-55x", false),
            ("gpt-6.1-sol", true),
            ("claude-opus", false),
            ("o4-mini", true),
            ("xo3", false),
            ("gpt-", false),
            ("gpt-12", true),
        ];
        for (m, want) in cases {
            assert_eq!(is_openai_reasoning(m), want, "{m}");
        }
        // An OpenAI reasoning model keeps `medium`, as effectiveEffort does.
        assert_eq!(effective_effort(Some(EffortLevel::Medium), "gpt-5"), EffortLevel::Medium);
        assert_eq!(effective_effort(Some(EffortLevel::Max), "gpt-5"), EffortLevel::High);
        assert_eq!(effective_effort(Some(EffortLevel::Medium), "gemma"), EffortLevel::Normal);
    }
    use EffortLevel::*;

    // Mirrors of anthropic.test.ts and model-capabilities.test.ts.

    #[test]
    fn rejects_sampling_from_the_4_7_generation_onwards() {
        let m = SamplingMemory::default();
        for id in [
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-sonnet-5",
            "claude-opus-6",
            "claude-fable-5-1",
            "claude-mythos-5-1",
            "my-proxy/claude-opus-5",
            "anthropic/claude-opus-5",
        ] {
            assert!(m.rejects_sampling(id), "{id}");
        }
        for id in [
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251001",
            "claude-3-5-sonnet-20241022",
            "my-proxy/claude-sonnet-4-6",
            "some-finetune-v2",
            "",
        ] {
            assert!(!m.rejects_sampling(id), "{id}");
        }
        // The two TS patterns disagree on a dated id; both are kept.
        assert!(m.rejects_sampling("claude-opus-4-20250514"));
        assert!(!uses_native_effort("claude-opus-4-20250514"));
    }

    #[test]
    fn learned_shapes_outrank_the_version_rule() {
        let m = SamplingMemory::default();
        m.learn("claude-opus-4-6", SamplingShape::Effort);
        assert!(m.rejects_sampling("CLAUDE-OPUS-4-6"));
        m.learn("claude-opus-5", SamplingShape::Neither);
        assert_eq!(m.first_shape("claude-opus-5"), SamplingShape::Neither);
        m.reset();
        assert_eq!(m.first_shape("claude-opus-5"), SamplingShape::Effort);
    }

    #[test]
    fn names_the_parameter_the_api_objected_to() {
        use SamplingShape as S;
        assert_eq!(sampling_param_error(400, "`temperature` is deprecated for this model."), Some(S::Temperature));
        assert_eq!(sampling_param_error(400, "top_p: unsupported parameter"), Some(S::Temperature));
        assert_eq!(sampling_param_error(400, "`output_config` is not supported"), Some(S::Effort));
        assert_eq!(sampling_param_error(429, "`temperature` is deprecated"), None);
        assert_eq!(sampling_param_error(400, "credit balance is too low"), None);
        assert_eq!(sampling_param_error(400, "model `temperature-test` not found"), None);
        // The word must come before the next full stop, on a word boundary.
        assert_eq!(sampling_param_error(400, "temperature. deprecated"), None);
        assert_eq!(sampling_param_error(400, "temperature is undeprecated"), None);
    }

    #[test]
    fn walks_the_shape_ladder() {
        use SamplingShape::*;
        assert_eq!(next_sampling_shape(Temperature, &[Temperature]), Some(Effort));
        assert_eq!(next_sampling_shape(Effort, &[Effort]), Some(Temperature));
        assert_eq!(next_sampling_shape(Effort, &[Temperature, Effort]), Some(Neither));
        assert_eq!(next_sampling_shape(Neither, &[Temperature, Effort, Neither]), None);
    }

    #[test]
    fn reads_effort_and_context_off_the_id() {
        assert_eq!(claude_context_window("claude-opus-5-5"), Some(1_000_000));
        assert_eq!(claude_context_window("claude-haiku-5-5"), Some(1_000_000));
        assert_eq!(claude_context_window("claude-haiku-4-5-20251001"), Some(200_000));
        assert_eq!(claude_context_window("claude-sonnet-4-5"), Some(200_000));
        assert_eq!(claude_context_window("gpt-5"), None);
        assert!(uses_native_effort("claude-haiku-5-5"));
        assert!(!uses_native_effort("claude-haiku-4-5-20251001"));
        assert_eq!(anthropic_effort("claude-haiku-5-5", Some(Xhigh)), Xhigh);
        assert_eq!(anthropic_effort("claude-opus-5", Some(Normal)), High);
        assert_eq!(anthropic_effort("claude-opus-5-5", Some(Normal)), Medium);
        assert_eq!(anthropic_effort("claude-opus-5", Some(Xhigh)), Xhigh);
        // A temperature model that reached the effort shape by retry.
        assert_eq!(anthropic_effort("claude-opus-4-6", Some(Xhigh)), High);
        assert_eq!(anthropic_effort("claude-opus-4-6", Some(Low)), Low);
        assert_eq!(anthropic_effort("claude-opus-4-6", None), High);
    }

    #[test]
    fn reads_the_output_ceiling_off_the_id() {
        assert_eq!(claude_max_output_tokens("claude-opus-5-5"), 64_000);
        assert_eq!(claude_max_output_tokens("anthropic/claude-opus-4-1"), 32_000);
        assert_eq!(claude_max_output_tokens("claude-opus-4-5"), 64_000);
        assert_eq!(claude_max_output_tokens("claude-sonnet-4-6"), 64_000);
        assert_eq!(claude_max_output_tokens("claude-sonnet-3-5"), 8_192);
        assert_eq!(claude_max_output_tokens("claude-haiku-4-5-20251001"), 64_000);
        assert_eq!(claude_max_output_tokens("claude-haiku-5-5"), 128_000);
        assert_eq!(claude_max_output_tokens("claude-fable-5-1"), 64_000);
        assert_eq!(claude_max_output_tokens("my-proxy-model"), 32_000);
    }

    #[test]
    fn learns_a_lower_output_ceiling() {
        let m = SamplingMemory::default();
        assert_eq!(m.output_cap_for("claude-opus-5-5", None), 64_000);
        assert_eq!(m.output_cap_for("claude-opus-5-5", Some(220)), 220);
        assert_eq!(m.output_cap_for("claude-opus-4-1", Some(100_000)), 32_000);
        m.learn_output_limit("anthropic/claude-opus-5-5", 16_000);
        assert_eq!(m.output_cap_for("claude-opus-5-5", None), 16_000);
        m.reset();
        assert_eq!(m.output_cap_for("claude-opus-5-5", None), 64_000);
    }

    #[test]
    fn reads_the_ceiling_out_of_a_max_tokens_400() {
        let body = r#"{"error":{"message":"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1"}}"#;
        assert_eq!(output_limit_error(400, body), Some(32_000));
        assert_eq!(output_limit_error(400, "max_tokens: must be greater than 0"), None);
        assert_eq!(output_limit_error(429, "max_tokens: 64000 > 32000"), None);
        assert_eq!(output_limit_error(400, "prompt is too long. max_tokens: 64000 > 32000"), Some(32_000));
        assert_eq!(output_limit_error(400, "max_tokens is required. 1 > 0"), None);
    }
}
