//! `request_secret` (#2594): the agent asks the user for a secret by name;
//! the user enters it in the chat's secret box, and the agent's commands get
//! it as an environment variable. The model only ever reads what is here:
//! the name, never the value.

use nekko_js as js;
use serde_json::{Value, json};

pub const REQUEST_SECRET: &str = "request_secret";

/// The tool, offered where `ask_user` is (a person reads the chat).
pub fn request_secret_tool() -> Value {
    json!({
        "name": REQUEST_SECRET,
        "description": "Ask the user for a secret a command needs (an API key, token or password) without ever seeing it. The chat shows the user a secure box where they paste or type it; the value goes straight to this computer's environment, never to you. Once given, every `bash` and `start_process` command in this chat has it as the environment variable `name` (use $NAME in sh/bash, $env:NAME in PowerShell, %NAME% in cmd), and any output that contains the value reaches you as [secret NAME]. Use this instead of asking the user to paste a secret into the chat, and only when a command really needs a credential the environment does not already have. Never try to print, encode or send the value anywhere the user did not ask for.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The environment variable to set, e.g. \"OPENAI_API_KEY\": letters, digits and _, not starting with a digit."
                },
                "reason": {
                    "type": "string",
                    "description": "One short line the user reads: what it is for and where they can get it, e.g. \"To call the OpenAI API. Create one at platform.openai.com/api-keys.\""
                }
            },
            "required": ["name", "reason"],
            "additionalProperties": false
        }
    })
}

/// Whether `name` can be an environment variable (as `nekko_tools::secrets::valid_name`).
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 64
}

/// The request the chat shows (`SecretRequest` in shared/chat.ts), or why the
/// call cannot be read.
pub fn parse_secret_request(call_id: &str, input: &Value, now: u64) -> Result<Value, String> {
    let name = input.get("name").and_then(Value::as_str).map(js::trim).unwrap_or_default();
    if !valid_name(name) {
        return Err(format!(
            "request_secret needs `name`: an environment variable name such as OPENAI_API_KEY (letters, digits and _, not starting with a digit). Got {name:?}."
        ));
    }
    let reason = input.get("reason").and_then(Value::as_str).map(js::trim).unwrap_or_default();
    Ok(json!({
        "callId": call_id,
        "name": name,
        "reason": js::slice16(reason, 300),
        "requestedAt": now,
    }))
}

/// What the model reads once the user has given the secret.
pub fn provided(name: &str) -> String {
    format!(
        "The user provided {name}. Every bash and start_process command in this chat now has it as the environment variable {name} (until the app restarts). Refer to it by name; its value is hidden from you and shows as [secret {name}] in any output."
    )
}

/// What the model reads when the user skipped it, or nobody answered.
pub fn skipped(name: &str, unattended: bool) -> String {
    if unattended {
        format!(
            "Nobody answered the request for {name} within the unattended time limit. Do not ask again: carry on without it, or stop and say what it is needed for."
        )
    } else {
        format!(
            "The user chose not to provide {name}. Do not ask for it again unless they bring it up: carry on without it, or say what it is needed for."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_request() {
        let req =
            parse_secret_request("c1", &json!({ "name": " OPENAI_API_KEY ", "reason": " For the API. " }), 5).unwrap();
        assert_eq!(
            req,
            json!({ "callId": "c1", "name": "OPENAI_API_KEY", "reason": "For the API.", "requestedAt": 5 })
        );
    }

    #[test]
    fn refuses_a_name_that_is_not_a_variable() {
        for bad in [json!({}), json!({ "name": "my key" }), json!({ "name": "1KEY" }), json!({ "name": "A-B" })] {
            assert!(parse_secret_request("c", &bad, 0).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_model_reads_names_only() {
        assert!(provided("TOKEN").contains("TOKEN") && skipped("TOKEN", false).contains("TOKEN"));
        assert!(skipped("TOKEN", true).contains("unattended"));
    }
}
