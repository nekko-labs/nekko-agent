//! The agents' picture tools on this computer's local image models
//! (`generate_image`, `edit_image`, `media_models`; spec/agents/media-tools-for-chat-agents.md).
//!
//! - Pictures go through the model server's media queue
//!   ([`crate::model_server::Server::media_job`]): one local picture or clip at a
//!   time, sized before it loads, swapped back when it pushed the chat's model out.
//! - The model: the one asked for, else this chat's own picture model
//!   (`imageParams.modelId`), else the first ready one that can do the task.
//! - The picture lands in the tool's result (`images`), so the chat shows it and
//!   the model sees it; with `inspect: false` only the saved file is reported.
//!   A `path` also saves it in the project as a new file, with `write_file`'s approval.
//! - Nothing here leaves the computer: no approval is asked to make a picture.

use crate::model_server::Server;
use base64::Engine as _;
use nekko_tools::{ToolCall, ToolContext};
use serde_json::{Value, json};

/// The tools, as the catalog names them.
pub const TOOLS: [&str; 3] = ["generate_image", "edit_image", "media_models"];

/// Variations a local model makes per call (decision 3: paid models make one).
const MAX_COUNT: u64 = 4;
const DEFAULT_SIDE: u64 = 1024;

fn ok(id: &str, output: impl Into<String>) -> Value {
    json!({ "toolCallId": id, "output": output.into() })
}

fn err(id: &str, output: impl Into<String>) -> Value {
    json!({ "toolCallId": id, "output": output.into(), "isError": true })
}

/// What a tool needs from the turn.
pub struct Call<'a> {
    pub call: &'a Value,
    /// The chat as the turn holds it (its `imageParams` and messages).
    pub session: Value,
    /// The chat's native tool context: paths, approvals and Stop.
    pub ctx: &'a ToolContext,
}

pub async fn run(server: &Server, c: Call<'_>) -> Value {
    let id = c.call.get("id").and_then(Value::as_str).unwrap_or_default();
    let name = c.call.get("name").and_then(Value::as_str).unwrap_or_default();
    let input = c.call.get("input").cloned().unwrap_or(json!({}));
    let models = server.ready_media_models().await;
    if name == "media_models" {
        return ok(id, list(&models));
    }
    let edit = name == "edit_image";
    let need = if edit { "edit" } else { "create" };
    let model = match choose(&models, &input, &c.session, need) {
        Ok(m) => m,
        Err(e) => return err(id, e),
    };
    let prompt = input.get("prompt").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if prompt.is_empty() {
        return err(id, "Describe the picture first (prompt).");
    }
    let (width, height) = match size(&input, &c.session) {
        Ok(s) => s,
        Err(e) => return err(id, e),
    };
    let count = if edit { 1 } else { input.get("count").and_then(Value::as_f64).map_or(1, |n| n as u64) };
    if !(1..=MAX_COUNT).contains(&count) {
        return err(id, format!("count is 1 to {MAX_COUNT}."));
    }
    let inspect = input.get("inspect") != Some(&Value::Bool(false));
    let path = input.get("path").filter(|p| p.as_str().is_some_and(|s| !s.trim().is_empty()));
    if !inspect && path.is_none() {
        return err(id, "With inspect false, give a path to save the picture to; otherwise it would be lost.");
    }
    if let Some(p) = path.and_then(Value::as_str)
        && !p.to_lowercase().ends_with(".png")
    {
        return err(id, "The path must end in .png.");
    }
    if path.is_some() && count > 1 {
        return err(id, "Save one picture at a time: use count 1 with a path.");
    }
    let refs = if edit {
        match pictures(&input, &c.session, c.ctx) {
            Ok(r) => r,
            Err(e) => return err(id, e),
        }
    } else {
        Vec::new()
    };
    let defaults = &model["defaults"];
    let params = c.session.get("imageParams").filter(|p| p.get("modelId") == model.get("id"));
    let pick = |k: &str, fallback: f64| {
        params
            .and_then(|p| p.get(k))
            .and_then(Value::as_f64)
            .or_else(|| defaults.get(k).and_then(Value::as_f64))
            .unwrap_or(fallback)
    };
    let mut request = json!({
        "modelId": model["id"],
        "prompt": prompt,
        "width": width,
        "height": height,
        "steps": pick("steps", 20.0),
        "cfgScale": pick("cfgScale", 4.5),
        "seed": -1,
    });
    if !refs.is_empty() {
        request["refImages"] = json!(refs);
    }

    let mut images = Vec::new();
    for _ in 0..count {
        let mut quiet = |_: &str| {};
        let made = tokio::select! {
            r = server.media_job(&request, false, &mut quiet) => r,
            _ = c.ctx.cancel.cancelled() => return err(id, "Stopped before the picture finished."),
        };
        match made {
            Ok(result) => images.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|d| d.get("b64_json").and_then(Value::as_str))
                    .map(str::to_string),
            ),
            Err(e) => return err(id, format!("The picture could not be made: {e}")),
        }
    }
    if images.is_empty() {
        return err(id, "The model finished without a picture.");
    }
    let label = model.get("name").and_then(Value::as_str).unwrap_or_default();
    let what = if edit {
        "Changed the picture"
    } else if images.len() > 1 {
        "Made the pictures"
    } else {
        "Made the picture"
    };
    let mut output = format!("{what} with {label} ({width}x{height}) on this computer.");
    if let Some(p) = path {
        let call = ToolCall { id: id.to_string(), name: name.to_string(), input: input.clone() };
        let bytes = match base64::engine::general_purpose::STANDARD.decode(&images[0]) {
            Ok(b) => b,
            Err(_) => return err(id, "The model returned a picture that could not be read."),
        };
        match nekko_tools::save_new_file(&call, c.ctx, Some(p), &bytes).await {
            Ok(saved) => output.push_str(&format!(" Saved to {saved}.")),
            Err(e) => output.push_str(&format!(" It was not saved: {e}")),
        }
    }
    let mut out = ok(id, output);
    if inspect {
        out["images"] = json!(images.iter().map(|b| format!("data:image/png;base64,{b}")).collect::<Vec<_>>());
    }
    out
}

/// `media_models`'s answer.
fn list(models: &[Value]) -> String {
    if models.is_empty() {
        return "No picture model is ready on this computer. The user can get one from a Photo chat or Model Server."
            .into();
    }
    let rows: Vec<String> = models
        .iter()
        .map(|m| {
            let can: Vec<&str> = m["capabilities"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            format!(
                "- {} ({}): {}, local",
                m["id"].as_str().unwrap_or_default(),
                m["name"].as_str().unwrap_or_default(),
                can.join(", ")
            )
        })
        .collect();
    format!("Picture models on this computer:\n{}", rows.join("\n"))
}

fn can(model: &Value, need: &str) -> bool {
    model["capabilities"].as_array().is_some_and(|c| c.iter().any(|x| x == need))
}

/// The model to use: asked for, the chat's own, or the first ready one that can.
fn choose(models: &[Value], input: &Value, session: &Value, need: &str) -> Result<Value, String> {
    let verb = if need == "edit" { "edits pictures" } else { "makes pictures" };
    if let Some(asked) = input.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let Some(m) = models.iter().find(|m| m["id"] == asked) else {
            return Err(format!("{asked} is not a ready picture model here. Call media_models for the list."));
        };
        if !can(m, need) {
            return Err(format!("{asked} cannot do that; choose one that {verb} (media_models)."));
        }
        return Ok(m.clone());
    }
    let own = session.get("imageParams").and_then(|p| p.get("modelId"));
    own.and_then(|o| models.iter().find(|m| &m["id"] == o && can(m, need)))
        .or_else(|| models.iter().find(|m| can(m, need)))
        .cloned()
        .ok_or_else(|| format!("No model on this computer {verb}. The user can get one from a Photo chat."))
}

/// `WIDTHxHEIGHT`, else the chat's last size, else 1024x1024.
fn size(input: &Value, session: &Value) -> Result<(u64, u64), String> {
    let problem = || "size is WIDTHxHEIGHT, each 256 to 2048 in multiples of 64 (e.g. 1024x1024).".to_string();
    let valid = |n: u64| (256..=2048).contains(&n) && n.is_multiple_of(64);
    if let Some(s) = input.get("size").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let (w, h) = s
            .trim()
            .to_lowercase()
            .split_once('x')
            .map(|(w, h)| (w.trim().parse(), h.trim().parse()))
            .ok_or_else(problem)?;
        let (w, h): (u64, u64) = (w.map_err(|_| problem())?, h.map_err(|_| problem())?);
        return if valid(w) && valid(h) { Ok((w, h)) } else { Err(problem()) };
    }
    let p = session.get("imageParams");
    let side = |k: &str| p.and_then(|p| p.get(k)).and_then(Value::as_u64).filter(|n| valid(*n));
    Ok((side("width").unwrap_or(DEFAULT_SIDE), side("height").unwrap_or(DEFAULT_SIDE)))
}

/// The pictures to edit, as data URLs: workspace files, or `last`.
fn pictures(input: &Value, session: &Value, ctx: &ToolContext) -> Result<Vec<String>, String> {
    let list: Vec<&str> =
        input.get("images").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if list.is_empty() || list.len() > 4 {
        return Err("Give 1 to 4 pictures to change (workspace paths, or \"last\").".into());
    }
    list.iter()
        .map(|p| {
            if *p == "last" {
                return last_picture(session).ok_or_else(|| "No picture was made in this chat yet.".to_string());
            }
            let full = nekko_tools::resolve_path(Some(&json!(p)), ctx)?;
            nekko_tools::assert_readable(&full, ctx)?;
            let mime = match full.rsplit('.').next().map(str::to_lowercase).as_deref() {
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                _ => return Err(format!("{p}: use a .png, .jpg, .jpeg or .webp picture.")),
            };
            let bytes = std::fs::read(&full).map_err(|e| format!("Could not read {p}: {e}"))?;
            Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
        })
        .collect()
}

/// The last picture this chat's picture tools made.
fn last_picture(session: &Value) -> Option<String> {
    let messages = session.get("messages").and_then(Value::as_array)?;
    let ours: Vec<&str> = messages
        .iter()
        .flat_map(|m| m.get("toolCalls").and_then(Value::as_array).into_iter().flatten())
        .filter(|c| matches!(c.get("name").and_then(Value::as_str), Some("generate_image" | "edit_image")))
        .filter_map(|c| c.get("id").and_then(Value::as_str))
        .collect();
    messages.iter().rev().find_map(|m| {
        let r = m.get("toolResult")?;
        let from = r.get("toolCallId").and_then(Value::as_str)?;
        if !ours.contains(&from) {
            return None;
        }
        r.get("images")?.as_array()?.last()?.as_str().filter(|s| s.starts_with("data:image/")).map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<Value> {
        vec![
            json!({ "id": "z", "name": "Z-Image", "capabilities": ["create"], "defaults": { "steps": 8, "cfgScale": 1 } }),
            json!({ "id": "k", "name": "FLUX.2 klein 4B", "capabilities": ["create", "edit"] }),
        ]
    }

    #[test]
    fn the_model_is_the_one_asked_for_then_the_chats_then_the_first_that_can() {
        let none = json!({});
        assert_eq!(choose(&models(), &none, &none, "create").unwrap()["id"], "z");
        assert_eq!(choose(&models(), &none, &none, "edit").unwrap()["id"], "k");
        let chat = json!({ "imageParams": { "modelId": "k" } });
        assert_eq!(choose(&models(), &none, &chat, "create").unwrap()["id"], "k");
        assert_eq!(choose(&models(), &json!({ "model": "z" }), &chat, "create").unwrap()["id"], "z");
        assert!(choose(&models(), &json!({ "model": "z" }), &none, "edit").unwrap_err().contains("cannot do that"));
        assert!(choose(&models(), &json!({ "model": "nope" }), &none, "create").unwrap_err().contains("media_models"));
        assert!(choose(&[], &none, &none, "create").is_err());
    }

    #[test]
    fn sizes_are_checked_and_default_to_the_chats() {
        assert_eq!(size(&json!({ "size": "1344x768" }), &json!({})), Ok((1344, 768)));
        assert!(size(&json!({ "size": "1000x768" }), &json!({})).is_err());
        assert!(size(&json!({ "size": "big" }), &json!({})).is_err());
        assert_eq!(size(&json!({}), &json!({ "imageParams": { "width": 512, "height": 768 } })), Ok((512, 768)));
        assert_eq!(size(&json!({}), &json!({})), Ok((1024, 1024)));
    }

    #[test]
    fn last_is_the_last_picture_these_tools_made() {
        let chat = json!({ "messages": [
            { "role": "assistant", "toolCalls": [{ "id": "a", "name": "generate_image" }] },
            { "role": "tool", "toolResult": { "toolCallId": "a", "images": ["data:image/png;base64,AAA"] } },
            { "role": "assistant", "toolCalls": [{ "id": "b", "name": "capture" }] },
            { "role": "tool", "toolResult": { "toolCallId": "b", "images": ["data:image/png;base64,SHOT"] } },
        ] });
        assert_eq!(last_picture(&chat).as_deref(), Some("data:image/png;base64,AAA"));
        assert_eq!(last_picture(&json!({ "messages": [] })), None);
    }

    #[test]
    fn the_list_says_what_each_model_can_do() {
        let text = list(&models());
        assert!(text.contains("- k (FLUX.2 klein 4B): create, edit, local"), "{text}");
        assert!(list(&[]).starts_with("No picture model"));
    }
}
