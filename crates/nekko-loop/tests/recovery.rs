use nekko_loop::{INTERRUPTED_TOOL_OUTPUT, repair_interrupted_history};
use serde_json::json;

#[test]
fn delayed_child_results_precede_followups_and_missing_calls_are_repaired() {
    let result = json!({ "role": "tool", "toolResult": { "toolCallId": "child", "output": "Files saved" } });
    let mut history = vec![
        json!({ "role": "assistant", "toolCalls": [{ "id": "child" }, { "id": "missing" }] }),
        json!({ "role": "user", "content": "are you stuck?" }),
        json!({ "role": "assistant", "content": "checking" }),
        result.clone(),
    ];
    assert_eq!(repair_interrupted_history(&mut history), 1);
    assert_eq!(history[1]["toolResult"]["output"], INTERRUPTED_TOOL_OUTPUT);
    assert_eq!(history[2], result);
    assert_eq!(history[3]["role"], "user");
    let before = history.clone();
    assert_eq!(repair_interrupted_history(&mut history), 0);
    assert_eq!(history, before);
}
