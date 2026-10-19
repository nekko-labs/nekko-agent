//! The Rust turn functions against the TS ones.
//!
//! `golden/expected.json` is written by `packages/host/src/turn-plan.golden.test.ts`
//! (UPDATE_GOLDEN=1), inputs and outputs side by side; this test runs every
//! input through the port and must match the output. Where the result is
//! saved to a chat file (the transcript, stats, plans, questions) it must
//! match as text, key order included.

use nekko_turn::{
    PlanOutcome, TurnStats, apply_plan_update, apply_turn_input, attach_turn_stats, catalog, chat_connectors,
    chat_effort, clean_title, format_ask_answers, host_tool_approval, parse_ask_request, plan_echo,
    send_options_for_queued_item, title_prompt, turn_system_prompt, turn_tools,
};
use serde_json::{Map, Value, json};
use std::path::Path;

fn expected() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn cases<'a>(all: &'a Value, key: &str) -> &'a Vec<Value> {
    let list = all[key].as_array().unwrap_or_else(|| panic!("no {key} cases"));
    assert!(!list.is_empty(), "no {key} cases");
    list
}

/// Same JSON text: same values and the same key order.
fn same_text(got: &Value, want: &Value, what: &str) {
    assert_eq!(serde_json::to_string(got).unwrap(), serde_json::to_string(want).unwrap(), "{what}");
}

const NOW: u64 = 1_760_000_000_000;

#[test]
fn tool_lists_match() {
    let all = expected();
    for (i, c) in cases(&all, "tools").iter().enumerate() {
        let got: Vec<Value> = turn_tools(&c["input"]).iter().map(|t| t["name"].clone()).collect();
        assert_eq!(Value::Array(got), c["output"], "tools case {i}: {}", c["input"]);
    }
}

#[test]
fn chat_scopes_match() {
    let all = expected();
    for (i, c) in cases(&all, "scopes").iter().enumerate() {
        let session = &c["input"]["session"];
        let connectors = c["input"]["connectors"].as_array().cloned().unwrap_or_default();
        let kinds: Vec<Value> = chat_connectors(connectors, session).iter().map(|k| k["kind"].clone()).collect();
        let got = json!({ "effort": chat_effort(session, c["input"].get("appEffort")).unwrap_or(Value::Null), "connectors": kinds });
        assert_eq!(got, c["output"], "scopes case {i}: {}", c["input"]);
    }
}

#[test]
fn system_prompts_match() {
    let all = expected();
    for (i, c) in cases(&all, "prompts").iter().enumerate() {
        let got = turn_system_prompt(&c["input"]);
        let want = c["output"].as_str().unwrap();
        if got != want {
            let at = got.chars().zip(want.chars()).take_while(|(a, b)| a == b).count();
            let from = at.saturating_sub(80);
            panic!(
                "prompt case {i} differs at char {at}:\n got: {:?}\nwant: {:?}",
                got.chars().skip(from).take(200).collect::<String>(),
                want.chars().skip(from).take(200).collect::<String>()
            );
        }
    }
}

/// Patch ids come from a process-wide counter: `msg_repair_<n>` becomes `msg_repair_N`.
fn normalize_patch_ids(v: &Value) -> Value {
    let text = serde_json::to_string(v).unwrap();
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find("msg_repair_") {
        let start = at + "msg_repair_".len();
        out.push_str(&rest[..start]);
        out.push('N');
        let digits = rest[start..].bytes().take_while(u8::is_ascii_digit).count();
        rest = &rest[start + digits..];
    }
    out.push_str(rest);
    serde_json::from_str(&out).unwrap()
}

#[test]
fn turn_input_lands_in_the_transcript_alike() {
    let all = expected();
    for (i, c) in cases(&all, "inputs").iter().enumerate() {
        let mut session = c["input"]["session"].clone();
        apply_turn_input(&mut session, &c["input"]["opts"], NOW);
        same_text(&normalize_patch_ids(&session), &c["output"], &format!("input case {i}"));
    }
}

#[test]
fn titles_match() {
    let all = expected();
    for (i, c) in cases(&all, "titles").iter().enumerate() {
        let got = title_prompt(c["input"].as_array().unwrap());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), c["output"], "title case {i}");
    }
    for (i, c) in cases(&all, "cleans").iter().enumerate() {
        assert_eq!(json!(clean_title(c["input"].as_str().unwrap())), c["output"], "clean case {i}");
    }
}

#[test]
fn queued_prompts_send_alike() {
    let all = expected();
    let base = json!({ "sessionId": "s", "providerId": "p", "modelId": "m", "text": "" });
    for (i, c) in cases(&all, "queued").iter().enumerate() {
        same_text(&send_options_for_queued_item(&base, &c["input"]), &c["output"], &format!("queued case {i}"));
    }
}

#[test]
fn questions_parse_and_answer_alike() {
    let all = expected();
    let ask = &all["ask"];
    for (i, c) in ask["parsed"].as_array().unwrap().iter().enumerate() {
        let got = match parse_ask_request("call_1", &c["input"], NOW) {
            Ok(request) => json!({ "request": request }),
            Err(error) => json!({ "error": error }),
        };
        same_text(&got, &c["output"], &format!("ask parse case {i}"));
    }
    for (i, c) in ask["formatted"].as_array().unwrap().iter().enumerate() {
        assert_eq!(json!(format_ask_answers(&ask["request"], &c["input"])), c["output"], "ask format case {i}");
    }
}

#[test]
fn plan_updates_match() {
    let all = expected();
    for (i, c) in cases(&all, "plans").iter().enumerate() {
        let current = c["input"].get("current").filter(|v| !v.is_null());
        let got = match apply_plan_update(current, &c["input"]["input"], NOW) {
            PlanOutcome::Applied { plan, replaced, finished, skipped_now } => {
                let echo = plan_echo(&plan);
                json!({ "plan": plan, "replaced": replaced, "finished": finished, "skippedNow": skipped_now, "echo": echo })
            }
            PlanOutcome::Refused(error) => json!({ "error": error }),
            PlanOutcome::Threw(message) => json!({ "threw": message }),
        };
        same_text(&got, &c["output"], &format!("plan case {i}"));
    }
}

#[test]
fn turn_stats_match() {
    let all = expected();
    for (i, c) in cases(&all, "stats").iter().enumerate() {
        let input = &c["input"];
        let identity: Map<String, Value> = input["identity"].as_object().cloned().unwrap();
        let mut acc = TurnStats::new(identity, input["startedAt"].as_f64().unwrap());
        for u in input["usage"].as_array().unwrap() {
            acc.add(u);
        }
        let end = input.get("end");
        let stats = acc.finish(
            input["endedAt"].as_f64().unwrap(),
            end.and_then(|e| e.get("steps")),
            end.and_then(|e| e.get("stop")),
        );
        let mut messages = vec![
            json!({ "id": "a0", "role": "assistant", "content": "before", "createdAt": 1 }),
            json!({ "id": "u", "role": "user", "content": "q", "createdAt": 2 }),
            json!({ "id": "a1", "role": "assistant", "content": "x", "createdAt": 3 }),
            json!({ "id": "t", "role": "tool", "content": "r", "toolCallId": "c", "createdAt": 4 }),
        ];
        let mut none: Vec<Value> = messages[..2].to_vec();
        let (at1, at_none) = match &stats {
            Some(s) => (json!(attach_turn_stats(&mut messages, 1, s)), json!(attach_turn_stats(&mut none, 2, s))),
            None => (Value::Null, Value::Null),
        };
        let got = json!({ "stats": stats, "attachedAt1": at1, "messages": messages, "attachedNone": at_none });
        same_text(&got, &c["output"], &format!("stats case {i}"));
    }
}

#[test]
fn the_catalog_is_the_one_the_ts_wrote() {
    // A smoke check that the embedded catalog parsed; its contents are
    // checked against the TS on every TS test run.
    assert!(catalog::catalog().builtin.iter().any(|t| t["name"] == "bash"));
}

#[test]
fn indirect_tool_approvals_match() {
    let all = expected();
    for (i, c) in cases(&all, "approvals").iter().enumerate() {
        let inp = &c["input"];
        let got = host_tool_approval(inp["name"].as_str().unwrap(), inp["mode"].as_str(), inp["sandboxMode"].as_str());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), c["output"], "approval case {i}: {inp}");
    }
}

#[test]
fn delegation_results_match() {
    use nekko_turn::delegate::*;
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("delegation.json");
    let all: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    assert_eq!(all["maxChildResumes"], json!(MAX_CHILD_RESUMES));
    for c in cases(&all, "resume") {
        assert_eq!(json!(can_resume_child_failure(c["input"].as_str().unwrap())), c["output"], "resume {}", c["input"]);
    }
    fn list(v: &Value) -> Option<&[Value]> {
        v.as_array().map(Vec::as_slice)
    }
    for (i, c) in cases(&all, "answers").iter().enumerate() {
        assert_eq!(json!(sub_agent_answer(list(&c["input"]))), c["output"], "answer {i}");
    }
    for (i, c) in cases(&all, "interrupted").iter().enumerate() {
        let inp = &c["input"];
        let got = child_interrupted_message(
            inp["childId"].as_str().unwrap(),
            inp["failure"].as_str().unwrap(),
            list(&inp["messages"]),
        );
        assert_eq!(json!(got), c["output"], "interrupted {i}");
    }
    for c in cases(&all, "failures") {
        same_text(&sub_agent_failure("call_1", c["input"].as_str().unwrap()), &c["output"], "failure");
    }
}

#[test]
fn decide_requests_match() {
    use nekko_turn::decide::{check_decision_request, decide_request_from_tool};
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("decide.json");
    let all: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    assert!(!all.is_empty());
    for (i, c) in all.iter().enumerate() {
        // The golden records long states by length; rebuild them.
        let mut input = c["input"].clone();
        if let Some(long) = input.get("state").and_then(|s| s.get("long")).and_then(Value::as_u64) {
            let head = input["state"]["head"].as_str().unwrap().to_string();
            let unit = head.chars().next().unwrap().to_string();
            let reps = long as usize / nekko_js::len16(&unit);
            input["state"] = json!(unit.repeat(reps));
        }
        let request = decide_request_from_tool(&input);
        let problem = check_decision_request(&request);
        assert_eq!(problem.map(Value::String).unwrap_or(Value::Null), c["problem"], "problem {i}");
        let mut shown = request.clone();
        if let Some(s) = request["state"].as_str()
            && nekko_js::len16(s) > 200
        {
            shown["state"] = json!({ "long": nekko_js::len16(s), "head": nekko_js::slice16(s, 20) });
        }
        assert_eq!(nekko_js::stringify(&shown), c["request"].as_str().unwrap(), "request {i}");
    }
}

#[test]
fn workflow_access_matches() {
    use nekko_turn::workflow_access as wa;
    // Shared with packages/shared/src/workflow-access.test.ts, which checks the
    // renderer's TS copy against the same cases.
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("workflow-access.json");
    let g: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let strings = |v: &Value| -> Vec<String> {
        v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    };
    for c in g["tokens"].as_array().unwrap() {
        let got = wa::tokenize_command(c["command"].as_str().unwrap());
        assert_eq!(json!(got), c["words"], "tokens {}", c["command"]);
    }
    for c in g["matches"].as_array().unwrap() {
        let got = match wa::command_allowed(c["command"].as_str().unwrap(), &strings(&c["allowed"])) {
            Ok(()) => json!({ "ok": true }),
            Err(r) => json!({ "ok": false, "reason": r }),
        };
        assert_eq!(got, c["verdict"], "match {} against {}", c["command"], c["allowed"]);
    }
    for c in g["disabled"].as_array().unwrap() {
        let got = wa::disabled_tools(c["access"].as_str(), &strings(&c["allowed"]));
        assert_eq!(json!(got), c["disabled"], "disabled {} {}", c["access"], c["allowed"]);
    }
    for c in g["decisions"].as_array().unwrap() {
        let got = wa::tool_decision(&c["session"], &c["call"]);
        assert_eq!(got, c["decision"], "decision {} {}", c["session"], c["call"]);
    }
}
