//! The workflow rules shared by the editor and the engine
//! (`packages/shared/src/workflows.ts`): cron (in local time), schedules,
//! trigger matching, step outcomes, event context and slugs.

use chrono::{Datelike, TimeZone, Timelike};
use serde_json::Value;

/// How many times one step may be entered in a run.
pub const MAX_STEP_LOOPS: u32 = 10;
/// How deep a workflow step may nest another workflow.
pub const MAX_WORKFLOW_DEPTH: u32 = 3;
pub const STEP_PASS_TOKEN: &str = "\u{27e6}PASS\u{27e7}";
pub const STEP_FAIL_TOKEN: &str = "\u{27e6}FAIL\u{27e7}";
pub const UNCATEGORIZED: &str = "Uncategorized";

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn truthy(v: Option<&Value>) -> bool {
    nekko_js::truthy(v)
}

/// `stepOutcomeInstruction(canRetry)`.
pub fn step_outcome_instruction(can_retry: bool) -> String {
    let second = if can_retry {
        format!("A {STEP_FAIL_TOKEN} sends the run back for another attempt, so say what went wrong before the token.")
    } else {
        format!("A {STEP_FAIL_TOKEN} ends the run, so say what blocked you before the token.")
    };
    format!(
        "When you are done, end your reply with {STEP_PASS_TOKEN} if this step succeeded, or {STEP_FAIL_TOKEN} if it did not. {second}"
    )
}

/// `readStepOutcome(text)`: the last token wins; neither counts as a pass.
pub fn read_step_outcome(text: &str) -> &'static str {
    let pass = text.rfind(STEP_PASS_TOKEN).map(|i| i as i64).unwrap_or(-1);
    let fail = text.rfind(STEP_FAIL_TOKEN).map(|i| i as i64).unwrap_or(-1);
    if fail > pass { "fail" } else { "pass" }
}

/// `slugify(name)`: URL- and CLI-safe, at most 48 characters, `workflow` when empty.
pub fn slugify(name: &str) -> String {
    let lower = name.to_lowercase();
    let parts: Vec<&str> =
        lower.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|p| !p.is_empty()).collect();
    let joined = parts.join("-");
    let cut: String = joined.chars().take(48).collect();
    let slug = cut.strip_suffix('-').unwrap_or(&cut);
    if slug.is_empty() { "workflow".into() } else { slug.to_string() }
}

/// `cliCommand(wf, trigger)`.
pub fn cli_command(wf: &Value, trigger: Option<&Value>) -> String {
    let cmd = trigger.and_then(|t| s(t, "command")).map(nekko_js::trim).unwrap_or("");
    if cmd.is_empty() { slugify(&nekko_js::display(wf.get("name").unwrap_or(&Value::Null))) } else { cmd.to_string() }
}

/// `triggerEnabled(t)`: absent flag means armed.
pub fn trigger_enabled(t: &Value) -> bool {
    t.get("enabled") != Some(&Value::Bool(false))
}

/// `Number(x)` and `Number.isInteger`.
fn integer(text: &str) -> Option<i64> {
    let n = nekko_js::string_to_number(text);
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

/// One cron field's values, `None` when malformed.
fn cron_field(spec: &str, min: i64, max: i64) -> Option<Vec<bool>> {
    let mut out = vec![false; (max + 1) as usize];
    let mut any = false;
    for part in spec.split(',') {
        let mut halves = part.split('/');
        let range = halves.next().unwrap_or("");
        let step_text = halves.next();
        let step = match step_text {
            None => 1,
            Some(t) => integer(t)?,
        };
        if step < 1 {
            return None;
        }
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if range.contains('-') {
            let mut ab = range.split('-');
            let a = integer(ab.next().unwrap_or(""))?;
            let b = integer(ab.next().unwrap_or(""))?;
            (a, b)
        } else {
            let v = integer(range)?;
            (v, if step_text.is_none() { v } else { max })
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            out[v as usize] = true;
            any = true;
            v += step;
        }
    }
    any.then_some(out)
}

/// A parsed cron expression: minute, hour, day of month, month, day of week,
/// and whether the two day fields are restricted (Vixie's OR rule).
pub struct Cron {
    sets: [Vec<bool>; 5],
    dom_restricted: bool,
    dow_restricted: bool,
}

const CRON_BOUNDS: [(i64, i64); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];

fn js_fields(expr: &str) -> Vec<&str> {
    nekko_js::trim(expr)
        .split(|c: char| nekko_js::is_js_space(c) || nekko_js::is_line_terminator(c))
        .filter(|f| !f.is_empty())
        .collect()
}

/// `parseCron(expr)`.
pub fn parse_cron(expr: &str) -> Option<Cron> {
    let fields = js_fields(expr);
    // `trim().split(/\s+/)` of an empty string is `['']`: one field.
    if fields.len() != 5 {
        return None;
    }
    let mut sets: Vec<Vec<bool>> = Vec::new();
    for (i, f) in fields.iter().enumerate() {
        sets.push(cron_field(f, CRON_BOUNDS[i].0, CRON_BOUNDS[i].1)?);
    }
    let sets: [Vec<bool>; 5] = sets.try_into().ok()?;
    Some(Cron { sets, dom_restricted: fields[2] != "*", dow_restricted: fields[4] != "*" })
}

pub fn is_valid_cron(expr: &str) -> bool {
    parse_cron(expr).is_some()
}

impl Cron {
    /// `cronMatches` at a local time.
    fn matches<Tz: TimeZone>(&self, at: &chrono::DateTime<Tz>) -> bool {
        let has = |set: &Vec<bool>, v: u32| set.get(v as usize).copied().unwrap_or(false);
        let dom = has(&self.sets[2], at.day());
        let dow = has(&self.sets[4], at.weekday().num_days_from_sunday());
        let day = if self.dom_restricted && self.dow_restricted { dom || dow } else { dom && dow };
        has(&self.sets[0], at.minute()) && has(&self.sets[1], at.hour()) && has(&self.sets[3], at.month()) && day
    }
}

/// `nextCronRun(expr, from)`: the next minute after `from` (local time in
/// `zone`) the expression fires, within a year.
pub fn next_cron_run<Tz: TimeZone>(zone: &Tz, expr: &str, from: f64) -> Option<f64> {
    let cron = parse_cron(expr)?;
    let start = local_minute_floor(zone, from + 60_000.0)?;
    let limit = 366 * 24 * 60;
    for i in 0..limit {
        let t = start + i * 60_000;
        let at = zone.timestamp_millis_opt(t).single()?;
        if cron.matches(&at) {
            return Some(t as f64);
        }
    }
    None
}

/// `new Date(t).setSeconds(0, 0)`: the local time with its seconds cleared,
/// turned back into an instant the way `Date` does it (an ambiguous local
/// time, as when clocks go back, takes the earlier instant; one in a gap
/// moves forward by the gap).
fn local_minute_floor<Tz: TimeZone>(zone: &Tz, t: f64) -> Option<i64> {
    use chrono::Offset;
    let at = zone.timestamp_millis_opt(t.floor() as i64).single()?;
    let local = at.naive_local().with_second(0)?.with_nanosecond(0)?;
    if let Some(x) = zone.from_local_datetime(&local).earliest() {
        return Some(x.timestamp_millis());
    }
    // In a gap: the offset before it, applied as if no change happened.
    let before = zone.offset_from_utc_datetime(&(local - chrono::Duration::hours(3))).fix().local_minus_utc();
    Some((local - chrono::Duration::seconds(i64::from(before))).and_utc().timestamp_millis())
}

/// `nextScheduledRun(wf, from)`: the earliest armed schedule trigger.
pub fn next_scheduled_run<Tz: TimeZone>(zone: &Tz, wf: &Value, from: f64) -> Option<f64> {
    let mut candidates = Vec::new();
    for t in wf.get("triggers").and_then(Value::as_array).into_iter().flatten().filter(|t| trigger_enabled(t)) {
        if s(t, "kind") != Some("schedule") {
            continue;
        }
        if truthy(t.get("cron")) {
            if let Some(next) = next_cron_run(zone, &nekko_js::display(&t["cron"]), from)
                && next != 0.0
            {
                candidates.push(next);
            }
        } else if truthy(t.get("intervalMs")) && nekko_js::to_number(t.get("intervalMs")) > 0.0 {
            let base = match wf.get("lastRunAt") {
                Some(v) if !v.is_null() => nekko_js::to_number(Some(v)),
                _ => from,
            };
            candidates.push(base + nekko_js::to_number(t.get("intervalMs")).max(60_000.0));
        }
    }
    candidates.into_iter().reduce(f64::min)
}

/// `branchMatches(branch, patterns)`: exact names or `*` globs.
pub fn branch_matches(branch: &str, patterns: Option<&Value>) -> bool {
    let list = patterns.and_then(Value::as_array).cloned().unwrap_or_default();
    if list.is_empty() {
        return true;
    }
    list.iter().any(|p| {
        let pattern = nekko_js::trim(&nekko_js::display(p)).to_string();
        if pattern.is_empty() {
            return false;
        }
        if !pattern.contains('*') {
            return pattern == branch;
        }
        glob(&pattern.split('*').collect::<Vec<_>>(), branch)
    })
}

/// `^seg0.*seg1.*...$` where `.` stops at a line terminator, as the TS regex does.
fn glob(segs: &[&str], text: &str) -> bool {
    let Some((first, rest)) = segs.split_first() else { return text.is_empty() };
    let Some(after) = text.strip_prefix(first) else { return false };
    if rest.is_empty() {
        return after.is_empty();
    }
    // Try every place the next wildcard could stop (it may not cross a line terminator).
    let mut i = 0;
    loop {
        if glob(rest, &after[i..]) {
            return true;
        }
        let Some(c) = after[i..].chars().next() else { return false };
        if nekko_js::is_line_terminator(c) {
            return false;
        }
        i += c.len_utf8();
    }
}

fn js_lower(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => nekko_js::display(v).to_lowercase(),
    }
}

/// `filterMatches(filter, e)`.
fn filter_matches(filter: Option<&Value>, e: &Value) -> bool {
    let f = filter.and_then(Value::as_str).unwrap_or("");
    if nekko_js::trim(f).is_empty() {
        return true;
    }
    let or = |k: &str| match e.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(v) => nekko_js::display(v),
    };
    let payload = nekko_js::stringify(e.get("payload").filter(|p| !p.is_null()).unwrap_or(&serde_json::json!({})));
    let hay = [or("text"), or("repo"), or("branch"), or("channel"), payload].join("\n").to_lowercase();
    hay.contains(&f.to_lowercase())
}

fn strip_hash_trim(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(|c| nekko_js::trim(c.strip_prefix('#').unwrap_or(c)).to_string())
}

/// `triggerAccepts(wf, t, e)`.
pub fn trigger_accepts(wf: &Value, t: &Value, e: &Value) -> bool {
    if !trigger_enabled(t) || t.get("kind") != e.get("kind") {
        return false;
    }
    if truthy(e.get("workflowId")) && wf.get("id") != e.get("workflowId") {
        return false;
    }
    match s(e, "kind") {
        Some("cli") => !truthy(e.get("command")) || Some(cli_command(wf, Some(t)).as_str()) == s(e, "command"),
        Some("slack") => {
            let want = strip_hash_trim(t.get("channel"));
            let got = strip_hash_trim(e.get("channel"));
            if want.as_deref().is_some_and(|w| !w.is_empty()) && want != got {
                return false;
            }
            if truthy(t.get("keyword")) && !js_lower(e.get("text")).contains(&js_lower(t.get("keyword"))) {
                return false;
            }
            true
        }
        Some("git") => {
            let provider = |v: &Value| s(v, "provider").unwrap_or("github").to_string();
            if provider(t) != provider(e) {
                return false;
            }
            let events = t.get("events").and_then(Value::as_array).filter(|a| !a.is_empty());
            if let Some(events) = events
                && truthy(e.get("event"))
                && !events.iter().any(|x| Some(x) == e.get("event"))
            {
                return false;
            }
            let repo = s(t, "repo").map(nekko_js::trim).unwrap_or("");
            if !repo.is_empty() && truthy(e.get("repo")) && Some(repo) != s(e, "repo") {
                return false;
            }
            if truthy(e.get("branch")) && !branch_matches(&nekko_js::display(&e["branch"]), t.get("branches")) {
                return false;
            }
            true
        }
        Some("connector") => {
            if truthy(t.get("connector")) && t.get("connector") != e.get("connector") {
                return false;
            }
            if truthy(t.get("event")) && t.get("event") != e.get("event") {
                return false;
            }
            filter_matches(t.get("filter"), e)
        }
        Some("webhook") => {
            if truthy(t.get("webhookSecret")) && t.get("webhookSecret") != e.get("secret") {
                return false;
            }
            filter_matches(t.get("filter"), e)
        }
        _ => true,
    }
}

/// `matchWorkflows(list, e)`: every enabled workflow the event should start.
pub fn match_workflows<'a>(list: &'a [Value], e: &Value) -> Vec<&'a Value> {
    list.iter()
        .filter(|wf| {
            truthy(wf.get("enabled"))
                && wf
                    .get("triggers")
                    .and_then(Value::as_array)
                    .is_some_and(|ts| ts.iter().any(|t| trigger_accepts(wf, t, e)))
        })
        .collect()
}

/// `eventContext(e)`: the lines a run's first prompt gets about its event.
pub fn event_context(e: &Value) -> String {
    let mut rows = Vec::new();
    for (k, label) in [
        ("provider", "provider"),
        ("event", "event"),
        ("repo", "repo"),
        ("branch", "branch"),
        ("channel", "channel"),
        ("text", "message"),
    ] {
        if truthy(e.get(k)) {
            rows.push(format!("{label}: {}", nekko_js::display(&e[k])));
        }
    }
    if let Some(p) = e.get("payload").and_then(Value::as_object) {
        for (k, v) in p {
            rows.push(format!("{k}: {}", nekko_js::display(v)));
        }
    }
    if rows.is_empty() { String::new() } else { format!("This run was triggered by an event:\n{}", rows.join("\n")) }
}

const GIT_PROVIDERS: &[(&str, &str)] =
    &[("github", "GitHub"), ("gitlab", "GitLab"), ("bitbucket", "Bitbucket"), ("other", "Other")];

/// `describeEvent(e)`: what set a run off, for its row.
pub fn describe_event(e: &Value) -> String {
    let field = |k: &str| match e.get(k) {
        None | Some(Value::Null) => None,
        Some(v) => Some(nekko_js::display(v)),
    };
    let join = |parts: Vec<Option<String>>| {
        parts.into_iter().flatten().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")
    };
    match s(e, "kind") {
        Some("git") => {
            let provider = s(e, "provider")
                .and_then(|p| GIT_PROVIDERS.iter().find(|(id, _)| *id == p).map(|(_, l)| (*l).to_string()))
                .or_else(|| field("provider"))
                .unwrap_or_else(|| "Git".into());
            join(vec![Some(provider), field("event"), field("repo"), field("branch")])
        }
        Some("slack") => nekko_js::trim(&format!("Slack {}", field("channel").unwrap_or_default())).to_string(),
        Some("cli") => nekko_js::trim(&format!("CLI {}", field("command").unwrap_or_default())).to_string(),
        Some("schedule") => "Schedule".into(),
        Some("connector") => {
            let labels = [
                ("slack", "Slack"),
                ("linear", "Linear"),
                ("jira", "Jira"),
                ("github", "GitHub"),
                ("gitlab", "GitLab"),
            ];
            let label = s(e, "connector")
                .and_then(|c| labels.iter().find(|(k, _)| *k == c).map(|(_, l)| (*l).to_string()))
                .or_else(|| field("connector"))
                .unwrap_or_else(|| "Connector".into());
            join(vec![Some(label), field("channel").or_else(|| field("repo")), field("event"), field("text")])
        }
        Some("webhook") => match field("slug").filter(|s| !s.is_empty()) {
            Some(slug) => format!("Webhook \u{b7} {slug}"),
            None => "Webhook".into(),
        },
        _ => "Manual".into(),
    }
}
