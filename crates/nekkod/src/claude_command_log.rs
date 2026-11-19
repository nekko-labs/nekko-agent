//! A Claude Agent chat's shell commands in its command log (#3067).
//!
//! Claude Code runs its own Bash and PowerShell tools, so they never pass
//! through Nekko's `bash` tool, which (with worktree setup) is what writes
//! the chat's "Agent commands" log that the Logs drawer shows. This turns the turn's
//! `tool_call` and `tool_result` events for those tools into the same lines
//! (`$ <command>`, then its output). Claude Code reports a command's output
//! only once it ends, so each command's output arrives in one piece.

use crate::harness::SHELL_TOOLS;
use serde_json::Value;
use std::collections::HashSet;

/// One turn's shell calls still waiting for their result.
#[derive(Default)]
pub struct ShellLog {
    open: HashSet<String>,
}

impl ShellLog {
    /// What `event` adds to the chat's command log, if anything.
    pub fn text(&mut self, event: &Value) -> Option<String> {
        match event.get("type").and_then(Value::as_str)? {
            "tool_call" => {
                let call = event.get("call")?;
                let name = call.get("name").and_then(Value::as_str)?;
                if !SHELL_TOOLS.contains(&name) {
                    return None;
                }
                let command = call.pointer("/input/command").and_then(Value::as_str)?;
                let id = call.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
                self.open.insert(id.to_string());
                let background = call.pointer("/input/run_in_background") == Some(&Value::Bool(true));
                Some(format!("$ {command}{}\n", if background { "  (in the background)" } else { "" }))
            }
            "tool_result" => {
                let result = event.get("result")?;
                let id = result.get("toolCallId").and_then(Value::as_str)?;
                if !self.open.remove(id) {
                    return None;
                }
                let output = result.get("output").and_then(Value::as_str).unwrap_or_default();
                if output.is_empty() {
                    return None;
                }
                Some(if output.ends_with('\n') { output.to_string() } else { format!("{output}\n") })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, name: &str, input: Value) -> Value {
        json!({ "type": "tool_call", "call": { "id": id, "name": name, "input": input, "executedBy": "claude-code" } })
    }

    fn result(id: &str, output: &str) -> Value {
        json!({ "type": "tool_result", "result": { "toolCallId": id, "output": output } })
    }

    #[test]
    fn a_shell_call_logs_its_command_then_its_output() {
        let mut log = ShellLog::default();
        assert_eq!(log.text(&call("t1", "Bash", json!({ "command": "npm test" }))).as_deref(), Some("$ npm test\n"));
        assert_eq!(log.text(&result("t1", "ok\n3 passed")).as_deref(), Some("ok\n3 passed\n"));
        // A result is logged once.
        assert_eq!(log.text(&result("t1", "again")), None);
    }

    #[test]
    fn powershell_and_background_commands_are_logged() {
        let mut log = ShellLog::default();
        let ps = log.text(&call("p", "PowerShell", json!({ "command": "Get-ChildItem" })));
        assert_eq!(ps.as_deref(), Some("$ Get-ChildItem\n"));
        let bg = log.text(&call("b", "Bash", json!({ "command": "npm run dev", "run_in_background": true })));
        assert_eq!(bg.as_deref(), Some("$ npm run dev  (in the background)\n"));
    }

    #[test]
    fn other_tools_and_events_are_not_logged() {
        let mut log = ShellLog::default();
        assert_eq!(log.text(&call("r", "Read", json!({ "file_path": "a.txt" }))), None);
        assert_eq!(log.text(&result("r", "file contents")), None);
        assert_eq!(log.text(&json!({ "type": "text", "delta": "$ hi" })), None);
        // A shell call with no command, or an empty result, adds nothing.
        assert_eq!(log.text(&call("e", "Bash", json!({}))), None);
        assert_eq!(log.text(&call("s", "Bash", json!({ "command": "true" }))).as_deref(), Some("$ true\n"));
        assert_eq!(log.text(&result("s", "")), None);
    }
}
