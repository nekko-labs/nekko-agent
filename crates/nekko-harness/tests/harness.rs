//! `map_event` and `run_turn` against recorded Claude Code stream-json
//! (tests/fixtures, see its README).

use nekko_harness::{Mapped, Mapper, Outcome, ReportedContext, StopKind, Transport, TurnExit, TurnInput, run_turn};
use nekko_loop::{Cancel, INTERRUPTED_NOTE, Steering};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io;
use std::time::Duration;

fn fixture(name: &str) -> Vec<String> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/// Map every line, finishing the turn at each `result` as the runner does.
fn map_all(lines: &[String]) -> Vec<Mapped> {
    let mut m = Mapper::new("s1");
    let mut out = Vec::new();
    for line in lines {
        for item in m.map_line(line) {
            if let Mapped::End(end) = &item {
                let end = end.clone();
                out.push(item);
                out.extend(m.finish(&end));
            } else {
                out.push(item);
            }
        }
    }
    out
}

fn events(items: &[Mapped]) -> Vec<Value> {
    items.iter().filter_map(|i| if let Mapped::Event(e) = i { Some(e.clone()) } else { None }).collect()
}

fn messages(items: &[Mapped]) -> Vec<Value> {
    items.iter().filter_map(|i| if let Mapped::Message(m) = i { Some(m.clone()) } else { None }).collect()
}

fn kinds(events: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in events {
        let k = e["type"].as_str().unwrap_or_default().to_string();
        // Runs of deltas collapse to one entry, so streaming chunking does not matter.
        if (k == "text" || k == "reasoning") && out.last() == Some(&k) {
            continue;
        }
        out.push(k);
    }
    out
}

fn text_of(events: &[Value], kind: &str) -> String {
    events.iter().filter(|e| e["type"] == kind).filter_map(|e| e["delta"].as_str()).collect()
}

#[test]
fn a_plain_turn_streams_text_then_usage_and_done() {
    let items = map_all(&fixture("api-key/turn.jsonl"));
    let ev = events(&items);
    assert_eq!(kinds(&ev), ["text", "usage", "done"]);
    assert!(ev.iter().all(|e| e["sessionId"] == "s1"));
    let msgs = messages(&items);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["role"], "assistant");
    assert_eq!(msgs[0]["content"].as_str(), Some(text_of(&ev, "text").as_str()));
    let done = ev.last().unwrap();
    assert_eq!(done["messageId"], msgs[0]["id"]);
    assert_eq!((done["stop"].as_str(), done["steps"].as_u64()), (Some("complete"), Some(0)));
    let init = items.iter().find_map(|i| if let Mapped::Init(i) = i { Some(i.clone()) } else { None }).unwrap();
    assert!(!init.session_id.is_empty());
    assert_eq!(init.api_key_source.as_deref(), Some("ANTHROPIC_API_KEY"));
}

#[test]
fn two_turns_on_one_process_keep_the_session_and_show_thinking() {
    let items = map_all(&fixture("api-key/two-turns.jsonl"));
    let inits: Vec<String> =
        items.iter().filter_map(|i| if let Mapped::Init(i) = i { Some(i.session_id.clone()) } else { None }).collect();
    assert_eq!(inits.len(), 2);
    assert_eq!(inits[0], inits[1]);
    let ev = events(&items);
    // Opus 5.5 does not display thinking by default: the blocks come empty and add nothing.
    assert_eq!(kinds(&ev), ["text", "usage", "done", "text", "usage", "done"]);
    assert!(messages(&items).iter().all(|m| m.get("reasoning").is_none()));
}

#[test]
fn partial_messages_are_not_sent_twice() {
    let lines = fixture("api-key/steer.jsonl");
    let items = map_all(&lines);
    let ev = events(&items);
    let msgs = messages(&items);
    // Each reply's text is exactly its deltas, never deltas plus the whole block again.
    let replies: Vec<&Value> = msgs.iter().filter(|m| m["role"] == "assistant").collect();
    assert_eq!(replies.len(), 2);
    let streamed = text_of(&ev, "text");
    let stored: String = replies.iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(streamed, stored);
    assert!(stored.contains("200"));
    assert!(stored.ends_with("steered"));
    let deltas = lines.iter().filter(|l| l.contains("\"text_delta\"")).count();
    assert_eq!(ev.iter().filter(|e| e["type"] == "text").count(), deltas);
}

#[test]
fn a_denied_tool_is_a_denied_result_and_the_turn_goes_on() {
    let items = map_all(&fixture("api-key/permission-denied.jsonl"));
    let ev = events(&items);
    assert_eq!(kinds(&ev), ["tool_call", "step", "tool_result", "text", "usage", "done"]);
    let call = &ev[0]["call"];
    assert_eq!((call["name"].as_str(), call["executedBy"].as_str()), (Some("Write"), Some("claude-code")));
    assert_eq!(call["input"]["content"], "hello");
    let result = &ev[2]["result"];
    assert_eq!(result["toolCallId"], call["id"]);
    assert_eq!((result["isError"].as_bool(), result["denied"].as_bool()), (Some(true), Some(true)));
    assert!(result["deniedReason"].as_str().is_some_and(|r| r.contains("no approval surface")));
    let msgs = messages(&items);
    let roles: Vec<&str> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["assistant", "tool", "assistant"]);
    assert_eq!(msgs[0]["toolCalls"][0]["id"], call["id"]);
    assert_eq!(ev[1]["messageId"], msgs[0]["id"]);
    assert_eq!(ev.last().unwrap()["steps"], 1);
}

#[test]
fn an_interrupt_is_a_stop_not_a_failure() {
    let lines = fixture("api-key/interrupt-control.jsonl");
    let mut m = Mapper::new("s1");
    m.expect_stop(StopKind::User);
    let mut items = Vec::new();
    let mut ends = Vec::new();
    for line in &lines {
        for item in m.map_line(line) {
            if let Mapped::End(end) = &item {
                ends.push(end.clone());
                items.extend(m.finish(end));
            }
            items.push(item);
        }
    }
    assert_eq!(ends[0].outcome, Outcome::Interrupted);
    assert_eq!(ends[0].terminal_reason.as_deref(), Some("aborted_streaming"));
    assert_eq!(ends[1].outcome, Outcome::Completed);
    let cut = &messages(&items)[0];
    assert_eq!(cut["interrupted"], true);
    assert!(cut["content"].as_str().unwrap().ends_with(INTERRUPTED_NOTE));
    let ev = events(&items);
    let errors: Vec<&Value> = ev.iter().filter(|e| e["type"] == "error").collect();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0]["message"], "Stopped");
    assert!(text_of(&ev, "text").ends_with("still-here"));
    assert!(items.iter().any(
        |i| matches!(i, Mapped::ControlResponse { request_id, error: None } if request_id == "probe-interrupt-1")
    ));
}

#[test]
fn a_killed_reply_keeps_what_streamed() {
    // Recorded up to the kill: no `result` ever comes.
    let lines = fixture("api-key/interrupt.jsonl");
    let mut m = Mapper::new("s1");
    let mut items: Vec<Mapped> = lines.iter().flat_map(|l| m.map_line(l)).collect();
    assert!(!items.iter().any(|i| matches!(i, Mapped::End(_))));
    items.extend(m.flush(true, true));
    items.extend(m.fail("Stopped"));
    let msgs = messages(&items);
    let last = msgs.last().unwrap();
    assert_eq!(last["interrupted"], true);
    assert!(last["content"].as_str().unwrap().starts_with(&text_of(&events(&items), "text")));
    assert!(last["content"].as_str().unwrap().ends_with(INTERRUPTED_NOTE));
}

#[test]
fn signed_out_reads_as_a_sign_in_prompt() {
    let items = map_all(&fixture("signed-out/turn-no-credentials.jsonl"));
    let ev = events(&items);
    assert_eq!(kinds(&ev), ["error"]);
    assert!(ev[0]["message"].as_str().unwrap().contains("/login"));
    assert!(messages(&items).is_empty());
    let end = items.iter().find_map(|i| if let Mapped::End(e) = i { Some(e.clone()) } else { None }).unwrap();
    assert!(matches!(end.outcome, Outcome::Failed(_)));
}

#[test]
fn tools_subagents_and_retries() {
    let items = map_all(&fixture("synthetic/tools-subagent-retry.jsonl"));
    let ev = events(&items);
    assert_eq!(
        kinds(&ev),
        [
            "retry",
            "reasoning",
            "text",
            "tool_call",
            "step",
            "tool_result",
            "tool_call",
            "tool_call",
            "tool_result",
            "step",
            "tool_result",
            "text",
            "usage",
            "done"
        ]
    );
    assert_eq!(ev[0]["attempt"], 1);
    assert_eq!(ev[0]["delayMs"], 500);
    assert_eq!(ev[0]["reason"], "overloaded_error");
    // Thinking and text streamed once each, though each also came whole.
    assert_eq!(text_of(&ev, "reasoning"), "List the files.");
    assert_eq!(text_of(&ev, "text"), "Checking.Two files; a.txt says hello.");
    // The sub-agent's own steps hang under the Task call and stay out of the transcript.
    let sub_call = &ev[7]["call"];
    assert_eq!((sub_call["name"].as_str(), sub_call["parentToolCallId"].as_str()), (Some("Read"), Some("toolu_task")));
    assert_eq!(ev[8]["result"]["parentToolCallId"], "toolu_task");
    assert_eq!(ev[8]["result"]["output"], "hello");
    let msgs = messages(&items);
    let shape: Vec<(String, usize)> = msgs
        .iter()
        .map(|m| (m["role"].as_str().unwrap().to_string(), m["toolCalls"].as_array().map_or(0, Vec::len)))
        .collect();
    assert_eq!(
        shape,
        [
            ("assistant".into(), 1),
            ("tool".into(), 0),
            ("assistant".into(), 1),
            ("tool".into(), 0),
            ("assistant".into(), 0)
        ]
    );
    assert_eq!(msgs[0]["reasoning"], "List the files.");
    assert_eq!(msgs[0]["content"], "Checking.");
    assert_eq!(msgs[3]["toolResult"]["output"], "a.txt says hello");
    let usage = ev.iter().find(|e| e["type"] == "usage").unwrap();
    assert_eq!((usage["inputTokens"].as_u64(), usage["cacheReadTokens"].as_u64()), (Some(10), Some(20000)));
    let done = ev.last().unwrap();
    assert_eq!((done["steps"].as_u64(), &done["messageId"]), (Some(2), &msgs[4]["id"]));
}

/// The reported context of each `result`, in order.
fn contexts(items: &[Mapped]) -> Vec<Option<ReportedContext>> {
    items.iter().filter_map(|i| if let Mapped::End(e) = i { Some(e.context) } else { None }).collect()
}

const fn reported(used: u64, window: Option<u64>) -> Option<ReportedContext> {
    Some(ReportedContext { used: Some(used), window })
}

#[test]
fn the_context_is_the_last_calls_input_against_claude_codes_window() {
    // input 2 + cache read 15417 + cache write 4821: Claude Code's own prompt and tools included.
    assert_eq!(contexts(&map_all(&fixture("api-key/turn.jsonl"))), [reported(20_240, Some(1_000_000))]);
    // Each turn reports its own, not a running total.
    assert_eq!(
        contexts(&map_all(&fixture("api-key/two-turns.jsonl"))),
        [reported(20_244, Some(1_000_000)), reported(20_311, Some(1_000_000))]
    );
}

#[test]
fn a_multi_call_turn_reports_its_last_call_while_usage_stays_the_total() {
    let items = map_all(&fixture("api-key/permission-denied.jsonl"));
    // The second call: 2 + 20243 + 347. Summing both calls would read 40837.
    assert_eq!(contexts(&items), [reported(20_592, Some(1_000_000))]);
    let usage = events(&items).into_iter().find(|e| e["type"] == "usage").unwrap();
    assert_eq!(
        (usage["inputTokens"].as_u64(), usage["cacheReadTokens"].as_u64(), usage["cacheWriteTokens"].as_u64()),
        (Some(4), Some(37_246), Some(3_587))
    );
}

#[test]
fn an_interrupted_turn_with_no_model_usage_keeps_the_occupancy() {
    let items = map_all(&fixture("api-key/interrupt-control.jsonl"));
    assert_eq!(contexts(&items), [reported(20_248, None), reported(20_299, Some(1_000_000))]);
}

#[test]
fn a_sub_agents_calls_are_not_the_chats_context() {
    let mut lines = fixture("api-key/turn.jsonl");
    let at = lines.iter().position(|l| l.contains("\"type\":\"result\"")).unwrap();
    let main = lines.iter().find(|l| l.contains("\"type\":\"assistant\"")).unwrap();
    let mut sub: Value = serde_json::from_str(main).unwrap();
    sub["parent_tool_use_id"] = json!("toolu_task");
    sub["message"]["id"] = json!("msg_sub");
    sub["message"]["content"] = json!([{ "type": "text", "text": "sub-agent" }]);
    sub["message"]["usage"] = json!({ "input_tokens": 90_000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 9 });
    lines.insert(at, sub.to_string());
    assert_eq!(contexts(&map_all(&lines)), [reported(20_240, Some(1_000_000))]);
}

// ---- run_turn over a scripted Claude Code ----

enum Step {
    Line(String),
    /// Hold until this many lines have been written to stdin.
    Gate(usize),
    /// The process exits.
    Eof,
}

struct Fake {
    script: VecDeque<Step>,
    sent: Vec<Value>,
    killed: bool,
    next_id: String,
}

impl Fake {
    fn new(script: Vec<Step>) -> Self {
        Self { script: script.into(), sent: Vec::new(), killed: false, next_id: "probe-interrupt-1".into() }
    }
}

impl Transport for Fake {
    async fn send(&mut self, line: Value) -> io::Result<()> {
        if self.killed {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "killed"));
        }
        self.sent.push(line);
        Ok(())
    }

    /// Cancel-safe, as the real session's channel receive is: `run_turn`
    /// drops this future whenever its tick or Stop wins the select, so it
    /// yields before taking a line, never after.
    async fn recv(&mut self) -> Option<String> {
        tokio::task::yield_now().await;
        loop {
            if self.killed {
                return None;
            }
            match self.script.front() {
                Some(Step::Gate(n)) if self.sent.len() >= *n => {
                    self.script.pop_front();
                }
                Some(Step::Gate(_)) | None => std::future::pending::<()>().await,
                Some(Step::Eof) => return None,
                Some(Step::Line(_)) => {
                    let Some(Step::Line(l)) = self.script.pop_front() else { unreachable!() };
                    return Some(l);
                }
            }
        }
    }

    fn kill(&mut self) {
        self.killed = true;
    }

    fn next_request_id(&mut self) -> String {
        self.next_id.clone()
    }

    fn diagnostics(&mut self) -> String {
        "Claude Code exited (exit code: 1).".into()
    }
}

fn lines(v: &[String]) -> Vec<Step> {
    v.iter().cloned().map(Step::Line).collect()
}

async fn drive(
    fake: &mut Fake,
    cancel: &Cancel,
    steering: &Steering,
    grace_ms: u64,
    require: Option<&str>,
) -> (TurnExit, Vec<Mapped>) {
    let mut out = Vec::new();
    let mut mapper = Mapper::new("s1");
    let input = TurnInput {
        content: json!("hello"),
        cancel,
        steering,
        interrupt_grace: Duration::from_millis(grace_ms),
        require_mcp: require,
    };
    let exit = run_turn(fake, &mut mapper, input, &mut |m| out.push(m)).await;
    (exit, out)
}

fn cancel_after(cancel: &Cancel, ms: u64) {
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        c.cancel();
    });
}

#[tokio::test]
async fn stop_sends_the_interrupt_and_keeps_the_process() {
    let rec = fixture("api-key/interrupt-control.jsonl");
    // Up to the first delta, then Claude Code waits for the interrupt (the 2nd line written).
    let mut script = lines(&rec[..5]);
    script.push(Step::Gate(2));
    script.extend(lines(&rec[5..9]));
    let mut fake = Fake::new(script);
    let (cancel, steering) = (Cancel::default(), Steering::default());
    cancel_after(&cancel, 50);
    let (exit, out) = drive(&mut fake, &cancel, &steering, 3_000, None).await;
    assert_eq!(exit, TurnExit::Stopped);
    assert!(!fake.killed);
    assert_eq!(fake.sent.len(), 2);
    assert_eq!(fake.sent[0]["type"], "user");
    assert_eq!(fake.sent[1], nekko_harness::interrupt_line("probe-interrupt-1"));
    let ev = events(&out);
    assert_eq!(ev.last().unwrap()["message"], "Stopped");
    assert!(!ev.iter().any(|e| e["type"] == "done"));
    assert_eq!(messages(&out).last().unwrap()["interrupted"], true);
}

#[tokio::test]
async fn an_unanswered_interrupt_falls_back_to_killing_the_tree() {
    let rec = fixture("api-key/interrupt.jsonl");
    let mut script = lines(&rec);
    script.push(Step::Gate(99));
    let mut fake = Fake::new(script);
    let (cancel, steering) = (Cancel::default(), Steering::default());
    cancel_after(&cancel, 50);
    let started = std::time::Instant::now();
    let (exit, out) = drive(&mut fake, &cancel, &steering, 300, None).await;
    assert_eq!(exit, TurnExit::Dead);
    assert!(fake.killed);
    assert!(started.elapsed() >= Duration::from_millis(300));
    let ev = events(&out);
    assert_eq!(ev.last().unwrap()["message"], "Stopped");
    let cut = messages(&out);
    assert_eq!(cut.last().unwrap()["interrupted"], true);
}

#[tokio::test]
async fn steering_interrupts_then_sends_the_new_message() {
    let rec = fixture("api-key/interrupt-control.jsonl");
    let mut script = lines(&rec[..5]);
    script.push(Step::Gate(2));
    script.extend(lines(&rec[5..9]));
    script.push(Step::Gate(3));
    script.extend(lines(&rec[9..]));
    let mut fake = Fake::new(script);
    let (cancel, steering) = (Cancel::default(), Steering::default());
    let steer = json!({ "id": "msg_steer", "role": "user", "content": "Say still-here instead.", "createdAt": 1 });
    {
        let s = steering.clone();
        let m = steer.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            s.lock().unwrap().push(m);
        });
    }
    let (exit, out) = drive(&mut fake, &cancel, &steering, 3_000, None).await;
    assert_eq!(exit, TurnExit::Completed);
    assert_eq!(fake.sent.len(), 3);
    assert_eq!(fake.sent[1]["type"], "control_request");
    assert_eq!(fake.sent[2], nekko_harness::user_line(json!("Say still-here instead.")));
    let ev = events(&out);
    let k = kinds(&ev);
    assert_eq!(k.iter().filter(|k| *k == "done").count(), 1);
    assert!(!k.contains(&"error".to_string()));
    let steered = ev.iter().position(|e| e["type"] == "steered").unwrap();
    assert_eq!(ev[steered]["messageId"], "msg_steer");
    assert_eq!(ev[steered]["sessionId"], "s1");
    let msgs = messages(&out);
    // The cut reply (no stop note: it was a steer), the steering message, the new reply.
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0]["interrupted"], true);
    assert!(!msgs[0]["content"].as_str().unwrap().contains(INTERRUPTED_NOTE));
    assert_eq!(msgs[1], steer);
    assert_eq!(msgs[2]["content"], "still-here");
    assert!(steering.lock().unwrap().is_empty());
}

#[tokio::test]
async fn permissions_fail_closed_when_the_bridge_is_down() {
    let mut init: Value = serde_json::from_str(&fixture("synthetic/tools-subagent-retry.jsonl")[0]).unwrap();
    init["mcp_servers"] = json!([{ "name": "nekko_bridge", "status": "failed" }]);
    let mut fake = Fake::new(vec![Step::Line(init.to_string()), Step::Gate(99)]);
    let (cancel, steering) = (Cancel::default(), Steering::default());
    let (exit, out) = drive(&mut fake, &cancel, &steering, 1_000, Some("nekko_bridge")).await;
    assert_eq!(exit, TurnExit::Dead);
    assert!(fake.killed);
    assert!(out.iter().any(|m| matches!(m, Mapped::Init(_))));
    let ev = events(&out);
    assert_eq!(kinds(&ev), ["error"]);
    assert!(ev[0]["message"].as_str().unwrap().contains("approval bridge"));

    // Connected, the same turn runs.
    let mut fake = Fake::new(lines(&fixture("synthetic/tools-subagent-retry.jsonl")));
    let (exit, out) = drive(&mut fake, &cancel, &steering, 1_000, Some("nekko_bridge")).await;
    assert_eq!(exit, TurnExit::Completed);
    assert_eq!(events(&out).last().unwrap()["type"], "done");
}

#[tokio::test]
async fn an_exit_mid_turn_reports_the_diagnostics() {
    let rec = fixture("api-key/interrupt.jsonl");
    let mut script = lines(&rec[..6]);
    script.push(Step::Eof);
    let mut fake = Fake::new(script);
    let (cancel, steering) = (Cancel::default(), Steering::default());
    let (exit, out) = drive(&mut fake, &cancel, &steering, 1_000, None).await;
    assert_eq!(exit, TurnExit::Dead);
    assert_eq!(events(&out).last().unwrap()["message"], "Claude Code exited (exit code: 1).");
}

#[tokio::test]
async fn control_requests_from_claude_code_are_declined() {
    let rec = fixture("api-key/turn.jsonl");
    let mut script = vec![Step::Line(rec[0].clone())];
    script.push(Step::Line(
        json!({ "type": "control_request", "request_id": "cc-1", "request": { "subtype": "can_use_tool" } })
            .to_string(),
    ));
    script.extend(lines(&rec[1..]));
    let mut fake = Fake::new(script);
    let (cancel, steering) = (Cancel::default(), Steering::default());
    let (exit, _) = drive(&mut fake, &cancel, &steering, 1_000, None).await;
    assert_eq!(exit, TurnExit::Completed);
    assert_eq!(fake.sent[1]["type"], "control_response");
    assert_eq!(fake.sent[1]["response"]["subtype"], "error");
    assert_eq!(fake.sent[1]["response"]["request_id"], "cc-1");
}
