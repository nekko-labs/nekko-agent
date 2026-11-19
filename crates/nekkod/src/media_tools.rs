//! The agents' picture tools on this computer's local image models
//! (`generate_image`, `edit_image`, `media_models`; spec/agents/media-tools-for-chat-agents.md).
//!
//! - Pictures go through the model server's media queue
//!   ([`crate::model_server::Server::media_job`]): one local picture or clip at a
//!   time, sized before it loads, swapped back when it pushed the chat's model out.
//! - The model: the one asked for, else this chat's own picture model
//!   (`imageParams.modelId`), else Settings → Agents → Pictures
//!   (`agentPictureModel`), else the first ready one that can do the task.
//! - The picture lands in the tool's result (`images`), so the chat shows it and
//!   the model sees it; with `inspect: false` only the saved file is reported.
//!   A `path` also saves it in the project as a new file, with `write_file`'s approval.
//! - Nothing here leaves the computer: no approval is asked to make a picture.

use crate::model_server::Server;
use base64::Engine as _;
use nekko_tools::{ToolCall, ToolContext};
use serde_json::{Value, json};
use std::sync::Arc;

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

type BoxFut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// What a paid cloud picture needs from the turn (turns.rs): the user's
/// OpenRouter models, one picture, and the chat's spending: a paid call asks
/// first with its price (in every mode, YOLO included, decided 2026-11-19)
/// unless the chat's allowance covers it, and records what it cost.
pub trait CloudSide: Send + Sync {
    fn models(&self) -> BoxFut<'_, Vec<Value>>;
    fn image(&self, request: Value) -> BoxFut<'_, Result<Value, String>>;
    /// May this call spend about `price` dollars? `what` is the approval's text.
    fn spend<'a>(&'a self, price: f64, what: &'a str) -> BoxFut<'a, Result<(), String>>;
    /// The call cost `cost` dollars (OpenRouter's own figure, else the price shown).
    fn spent<'a>(&'a self, cost: f64, model: &'a str) -> BoxFut<'a, ()>;
}

/// What a tool needs from the turn.
pub struct Call<'a> {
    pub call: &'a Value,
    /// The chat as the turn holds it (its `imageParams` and messages).
    pub session: Value,
    /// The chat's native tool context: paths, approvals and Stop.
    pub ctx: &'a ToolContext,
    /// `settings.agentPictureModel`: the default when the call and the chat name none.
    pub default: Option<String>,
    /// Cloud pictures, where this chat may use them (not offline or Local only).
    pub cloud: Option<&'a dyn CloudSide>,
}

pub async fn run(server: &Server, c: Call<'_>) -> Value {
    let id = c.call.get("id").and_then(Value::as_str).unwrap_or_default();
    let name = c.call.get("name").and_then(Value::as_str).unwrap_or_default();
    let input = c.call.get("input").cloned().unwrap_or(json!({}));
    let mut models = server.ready_media_models().await;
    if let Some(cloud) = c.cloud {
        models.extend(cloud.models().await);
    }
    if name == "media_models" {
        return ok(id, list(&models));
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
    if path.is_some() && input.get("count").and_then(Value::as_f64).is_some_and(|n| n > 1.0) {
        return err(id, "Save one picture at a time: use count 1 with a path.");
    }
    let ctx = c.ctx;
    let read = |p: &str| -> Result<String, String> {
        let full = nekko_tools::resolve_path(Some(&json!(p)), ctx)?;
        nekko_tools::assert_readable(&full, ctx)?;
        read_picture(p, &full)
    };
    let request = Request {
        name,
        input: &input,
        session: &c.session,
        default: c.default.as_deref(),
        last: last_picture(&c.session),
        read: &read,
        cloud: c.cloud,
    };
    let made = tokio::select! {
        r = make(server, &models, request) => r,
        _ = c.ctx.cancel.cancelled() => return err(id, "Stopped before the picture finished."),
    };
    let Made { images, mut output } = match made {
        Ok(m) => m,
        Err(e) => return err(id, e),
    };
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

/// A Claude Code chat's call through its bridge (`POST /harness/tool`): the
/// same pictures, kept in `saved` (the chat's own folder in Nekko's data, so
/// nothing is written into the project behind Claude Code's back) and named
/// in the answer, which Claude Code can copy with its own tools and their
/// approvals. Pictures to edit come from the chat's folders (`roots`) or `last`.
/// The answer is the bridge's `{ ok, text, images? }`, images as bare base64 PNG.
pub async fn run_bridge(
    server: &Server,
    name: &str,
    input: &Value,
    session: &Value,
    default: Option<&str>,
    roots: &[std::path::PathBuf],
    saved: &std::path::Path,
) -> Value {
    let fail = |e: String| json!({ "ok": false, "error": e });
    let models = server.ready_media_models().await;
    if name == "media_models" {
        return json!({ "ok": true, "text": list(&models) });
    }
    let read = |p: &str| -> Result<String, String> {
        let full = inside(roots, p)?;
        read_picture(p, &full.to_string_lossy())
    };
    let request = Request { name, input, session, default, last: newest_saved(saved), read: &read, cloud: None };
    let Made { images, mut output } = match make(server, &models, request).await {
        Ok(m) => m,
        Err(e) => return fail(e),
    };
    if let Err(e) = std::fs::create_dir_all(saved) {
        return fail(format!("Could not keep the picture: {e}"));
    }
    let stamp = nekko_js::now_ms();
    let mut paths = Vec::new();
    for (i, b) in images.iter().enumerate() {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b) else {
            return fail("The model returned a picture that could not be read.".into());
        };
        let file = saved.join(format!("picture-{stamp}-{}.png", i + 1));
        if let Err(e) = std::fs::write(&file, bytes) {
            return fail(format!("Could not keep the picture: {e}"));
        }
        paths.push(file.to_string_lossy().to_string());
    }
    output.push_str(&format!(
        " Kept at {}. Copy it into the project with your own tools if the user wants it there.",
        paths.join(", ")
    ));
    json!({ "ok": true, "text": output, "images": images })
}

/// `generate_video`'s name, apart from the picture tools: it is offered with a
/// ready video model and answers before the clip exists.
pub const VIDEO_TOOL: &str = "generate_video";

/// What finishing a clip says when it was not asked for (`then`).
const CLIP_THEN: &str = "Show the user the clip and continue the task.";

/// A clip to start (`generate_video`): the caller has already read the first
/// frame (as a data URL) and approved the project path, while the turn could ask.
pub struct Clip<'a> {
    pub session_id: &'a str,
    pub input: &'a Value,
    pub first_frame: Option<String>,
    /// A new project file to also write the clip to, already approved.
    pub project_path: Option<String>,
    /// Where Nekko keeps the clip: the chat's own folder in its data.
    pub kept: std::path::PathBuf,
}

/// Start a clip on this computer's video model and arm the `clip` watch that
/// wakes the chat when it ends (made, failed, or stopped by the chat's Stop or
/// the watch's cancel). Returns at once with what the agent is told.
pub async fn start_clip(
    server: Arc<Server>,
    watches: Arc<crate::watches::Watches>,
    c: Clip<'_>,
) -> Result<String, String> {
    let models = server.ready_video_models().await;
    let model = match c.input.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(asked) => models
            .iter()
            .find(|m| m["id"] == asked)
            .cloned()
            .ok_or_else(|| format!("{asked} is not a ready video model on this computer."))?,
        None => models.first().cloned().ok_or("No video model is ready on this computer.")?,
    };
    let prompt = c.input.get("prompt").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if prompt.is_empty() {
        return Err("Describe the clip first (prompt).".into());
    }
    let shape = match c.input.get("size").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        Some(s) => s
            .trim()
            .to_lowercase()
            .split_once('x')
            .and_then(|(w, h)| Some((w.trim().parse::<f64>().ok()?, h.trim().parse::<f64>().ok()?)))
            .filter(|(w, h)| *w > 0.0 && *h > 0.0)
            .ok_or("size is WIDTHxHEIGHT, for example 832x480.")?,
        // About 16:9, which the engine scales to the documented 832x480.
        None => (1344.0, 768.0),
    };
    // The request carries the shape as a picture size (multiples of 64); the
    // engine scales it to a clip's pixel count (`video_generation_body`).
    let snap = |n: f64| ((n / 64.0).round() * 64.0).clamp(256.0, 2048.0);
    let ratio = shape.0 / shape.1;
    let (shape_w, shape_h) =
        if ratio >= 1.0 { (snap(1344.0), snap(1344.0 / ratio)) } else { (snap(1344.0 * ratio), snap(1344.0)) };
    let (width, height) = nekko_engine::launch::clip_size(shape_w, shape_h);
    let defaults = &model["defaults"];
    let num = |k: &str, d: f64| defaults.get(k).and_then(Value::as_f64).unwrap_or(d);
    let mut request = json!({
        "modelId": model["id"], "prompt": prompt, "width": shape_w, "height": shape_h,
        "steps": num("steps", 20.0), "cfgScale": num("cfgScale", 5.0), "seed": -1,
    });
    if let Some(f) = &c.first_frame {
        request["refImages"] = json!([f]);
    }
    let then =
        c.input.get("then").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).unwrap_or(CLIP_THEN);
    let cancel = nekko_loop::Cancel::default();
    let id = watches.arm_clip(c.session_id, then, cancel.clone()).await?;
    let label = model.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let (kept, project, watch, name) = (c.kept.clone(), c.project_path.clone(), id.clone(), label.clone());
    let (stages, mut heard) = tokio::sync::mpsc::unbounded_channel::<String>();
    {
        // The chip follows the job's stages; a stage that repeats is not news.
        let (watches, id, session) = (watches.clone(), id.clone(), c.session_id.to_string());
        tokio::spawn(async move {
            let mut last = String::new();
            while let Some(stage) = heard.recv().await {
                if stage != last {
                    watches.clip_progress(&id, &session, &stage).await;
                    last = stage;
                }
            }
        });
    }
    tokio::spawn(async move {
        let mut tell = |stage: &str| {
            let _ = stages.send(stage.to_string());
        };
        let made = tokio::select! {
            r = server.media_job(&request, true, &mut tell) => r,
            // Cancelled: the watch is already gone, so nobody is told.
            _ = cancel.cancelled() => return,
        };
        let news = match made.and_then(|r| keep_clip(&r, &kept, project.as_deref())) {
            Ok(paths) => format!("The clip is ready ({name}, {width}x{height}): {}.", paths.join(" and ")),
            Err(e) => format!("The clip could not be made: {e}"),
        };
        watches.clip_finished(&watch, &news).await;
    });
    Ok(format!(
        "Started a {width}x{height} clip with {label} on this computer (experimental). It takes minutes; watch {id} wakes this chat with the clip when it is ready, and the chat's Stop cancels it. Tell the user and end your turn now."
    ))
}

/// Write a finished clip where it is kept, and to the approved project path.
fn keep_clip(result: &Value, kept: &std::path::Path, project: Option<&str>) -> Result<Vec<String>, String> {
    let b64 =
        result.get("b64_json").and_then(Value::as_str).filter(|b| !b.is_empty()).ok_or("the model returned no clip")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "the clip could not be read")?;
    let ext = match result.get("mime_type").and_then(Value::as_str) {
        Some("video/webm") => "webm",
        Some("image/gif") => "gif",
        _ => "webp",
    };
    std::fs::create_dir_all(kept).map_err(|e| format!("could not keep the clip: {e}"))?;
    let file = kept.join(format!("clip-{}.{ext}", nekko_js::now_ms()));
    std::fs::write(&file, &bytes).map_err(|e| format!("could not keep the clip: {e}"))?;
    let mut paths = vec![file.to_string_lossy().to_string()];
    if let Some(p) = project {
        if let Some(parent) = std::path::Path::new(p).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(p, &bytes) {
            Ok(()) => paths.push(p.to_string()),
            Err(e) => paths.push(format!("(not saved to {p}: {e})")),
        }
    }
    Ok(paths)
}

/// The first frame a native call names: a workspace picture, or `last`.
pub fn native_frame(input: &Value, session: &Value, ctx: &ToolContext) -> Result<Option<String>, String> {
    match input.get("image").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        None => Ok(None),
        Some("last") => last_picture(session).map(Some).ok_or_else(|| "No picture was made in this chat yet.".into()),
        Some(p) => {
            let full = nekko_tools::resolve_path(Some(&json!(p)), ctx)?;
            nekko_tools::assert_readable(&full, ctx)?;
            read_picture(p, &full).map(Some)
        }
    }
}

/// The first frame a Claude Code call names: a picture in the chat's folders, or `last`.
pub fn bridge_frame(
    input: &Value,
    roots: &[std::path::PathBuf],
    saved: &std::path::Path,
) -> Result<Option<String>, String> {
    match input.get("image").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        None => Ok(None),
        Some("last") => newest_saved(saved).map(Some).ok_or_else(|| "No picture was made in this chat yet.".into()),
        Some(p) => read_picture(p, &inside(roots, p)?.to_string_lossy()).map(Some),
    }
}

/// What [`make`] needs from either caller.
struct Request<'a> {
    name: &'a str,
    input: &'a Value,
    session: &'a Value,
    default: Option<&'a str>,
    /// The picture `"last"` names, when there is one.
    last: Option<String>,
    /// A picture to edit, from the chat's folders, as a data URL.
    read: &'a (dyn Fn(&str) -> Result<String, String> + Sync),
    cloud: Option<&'a dyn CloudSide>,
}

struct Made {
    /// Bare base64 PNGs.
    images: Vec<String>,
    output: String,
}

/// Choose the model, check the call, and make the pictures through the media queue.
async fn make(server: &Server, models: &[Value], r: Request<'_>) -> Result<Made, String> {
    let edit = r.name == "edit_image";
    let need = if edit { "edit" } else { "create" };
    let model = choose(models, r.input, r.session, r.default, need)?;
    let prompt = r.input.get("prompt").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if prompt.is_empty() {
        return Err("Describe the picture first (prompt).".into());
    }
    let (width, height) = size(r.input, r.session)?;
    let count = if edit { 1 } else { r.input.get("count").and_then(Value::as_f64).map_or(1, |n| n as u64) };
    if !(1..=MAX_COUNT).contains(&count) {
        return Err(format!("count is 1 to {MAX_COUNT}."));
    }
    let refs = if edit { pictures(r.input, r.last.as_deref(), r.read)? } else { Vec::new() };
    if model["source"] == "cloud" {
        let cloud = r.cloud.ok_or("Cloud pictures are not available in this chat.")?;
        return paid(cloud, &model, prompt, (width, height), count, refs).await;
    }
    let defaults = &model["defaults"];
    let params = r.session.get("imageParams").filter(|p| p.get("modelId") == model.get("id"));
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
        let result = server
            .media_job(&request, false, &mut quiet)
            .await
            .map_err(|e| format!("The picture could not be made: {e}"))?;
        images.extend(
            result
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|d| d.get("b64_json").and_then(Value::as_str))
                .map(str::to_string),
        );
    }
    if images.is_empty() {
        return Err("The model finished without a picture.".into());
    }
    let label = model.get("name").and_then(Value::as_str).unwrap_or_default();
    let what = if edit {
        "Changed the picture"
    } else if images.len() > 1 {
        "Made the pictures"
    } else {
        "Made the picture"
    };
    Ok(Made { images, output: format!("{what} with {label} ({width}x{height}) on this computer.") })
}

/// One picture from a paid cloud model: its price asked for (or covered by
/// the chat's allowance) first, then made, then its cost recorded.
async fn paid(
    cloud: &dyn CloudSide,
    model: &Value,
    prompt: &str,
    size: (u64, u64),
    count: u64,
    refs: Vec<String>,
) -> Result<Made, String> {
    if count > 1 {
        return Err("Paid models make one picture per call, so each charge is shown; call again for another.".into());
    }
    let name = model["name"].as_str().unwrap_or_default();
    let price = model["priceUsd"].as_f64().ok_or("This cloud model has no published price per picture.")?;
    let about = if model["priceExact"] == true { "" } else { "about " };
    let photos =
        if refs.is_empty() { "The prompt" } else { "The prompt and the pictures to change leave this computer:" };
    let what = format!(
        "Make 1 picture with {name} through OpenRouter for {about}${price:.3}, on your OpenRouter account. {photos} sent to OpenRouter and the model's provider."
    );
    cloud.spend(price, &what).await?;
    let mut request = json!({
        "id": model["id"], "prompt": prompt, "aspectRatio": crate::cloud_media::aspect_ratio(size.0, size.1),
    });
    if !refs.is_empty() {
        request["images"] = json!(refs);
    }
    let made = cloud.image(request).await.map_err(|e| format!("The picture could not be made: {e}"))?;
    let cost = made["costUsd"].as_f64().unwrap_or(price);
    cloud.spent(cost, model["id"].as_str().unwrap_or_default()).await;
    let b64 = made["b64"].as_str().unwrap_or_default().to_string();
    if b64.is_empty() {
        return Err("The model finished without a picture.".into());
    }
    let verb = if refs.is_empty() { "Made the picture" } else { "Changed the picture" };
    Ok(Made { images: vec![b64], output: format!("{verb} with {name} through OpenRouter (cost ${cost:.3}).") })
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
            let place = match m["priceUsd"].as_f64() {
                Some(p) if m["source"] == "cloud" => {
                    let about = if m["priceExact"] == true { "" } else { "about " };
                    format!("cloud through OpenRouter, {about}${p:.3} a picture, asks before paying")
                }
                _ => "local, free".to_string(),
            };
            format!(
                "- {} ({}): {}, {place}",
                m["id"].as_str().unwrap_or_default(),
                m["name"].as_str().unwrap_or_default(),
                can.join(", ")
            )
        })
        .collect();
    format!("Picture models this chat can use:\n{}", rows.join("\n"))
}

fn can(model: &Value, need: &str) -> bool {
    model["capabilities"].as_array().is_some_and(|c| c.iter().any(|x| x == need))
}

/// The model to use: asked for, the chat's own, the Settings default, or the
/// first ready one that can. A chat or default model that is not ready, or
/// cannot do the task, is passed over rather than refused.
fn choose(
    models: &[Value],
    input: &Value,
    session: &Value,
    default: Option<&str>,
    need: &str,
) -> Result<Value, String> {
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
    let own = session.get("imageParams").and_then(|p| p.get("modelId")).and_then(Value::as_str);
    let ready = |id: Option<&str>| id.and_then(|id| models.iter().find(|m| m["id"] == id && can(m, need)));
    // A paid cloud model is used only when named (the call, the chat or
    // Settings); the automatic choice stays on this computer.
    ready(own)
        .or_else(|| ready(default))
        .or_else(|| models.iter().find(|m| can(m, need) && m["source"] != "cloud"))
        .cloned()
        .ok_or_else(|| format!("No model on this computer {verb}. The user can get one from a Photo chat, or name a cloud model from media_models."))
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

/// The pictures to edit, as data URLs: files from the chat's folders, or `last`.
fn pictures(
    input: &Value,
    last: Option<&str>,
    read: &(dyn Fn(&str) -> Result<String, String> + Sync),
) -> Result<Vec<String>, String> {
    let list: Vec<&str> =
        input.get("images").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if list.is_empty() || list.len() > 4 {
        return Err("Give 1 to 4 pictures to change (paths in the chat's folders, or \"last\").".into());
    }
    list.iter()
        .map(|p| {
            if *p == "last" {
                last.map(str::to_string).ok_or_else(|| "No picture was made in this chat yet.".to_string())
            } else {
                read(p)
            }
        })
        .collect()
}

/// A picture file as a data URL, by its extension.
fn read_picture(asked: &str, full: &str) -> Result<String, String> {
    let mime = match full.rsplit('.').next().map(str::to_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(format!("{asked}: use a .png, .jpg, .jpeg or .webp picture.")),
    };
    let bytes = std::fs::read(full).map_err(|e| format!("Could not read {asked}: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A path inside one of the chat's folders (relative to the first), links
/// resolved, or why not.
fn inside(roots: &[std::path::PathBuf], asked: &str) -> Result<std::path::PathBuf, String> {
    let first = roots.first().ok_or("This chat has no folder to read pictures from.")?;
    let path = std::path::Path::new(asked);
    let joined = if path.is_absolute() { path.to_path_buf() } else { first.join(path) };
    let real = joined.canonicalize().map_err(|_| format!("{asked} was not found."))?;
    let ok = roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| real.starts_with(&r));
    if ok { Ok(real) } else { Err(format!("{asked} is outside this chat's folders.")) }
}

/// The newest picture kept for a Claude Code chat: what its `last` names.
fn newest_saved(dir: &std::path::Path) -> Option<String> {
    let newest = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".png"))
        .max_by_key(|e| e.file_name())?;
    read_picture("last", &newest.path().to_string_lossy()).ok()
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
        assert_eq!(choose(&models(), &none, &none, None, "create").unwrap()["id"], "z");
        assert_eq!(choose(&models(), &none, &none, None, "edit").unwrap()["id"], "k");
        let chat = json!({ "imageParams": { "modelId": "k" } });
        assert_eq!(choose(&models(), &none, &chat, None, "create").unwrap()["id"], "k");
        assert_eq!(choose(&models(), &json!({ "model": "z" }), &chat, None, "create").unwrap()["id"], "z");
        assert!(
            choose(&models(), &json!({ "model": "z" }), &none, None, "edit").unwrap_err().contains("cannot do that")
        );
        assert!(
            choose(&models(), &json!({ "model": "nope" }), &none, None, "create").unwrap_err().contains("media_models")
        );
        assert!(choose(&[], &none, &none, None, "create").is_err());
    }

    #[test]
    fn a_cloud_model_is_used_only_when_named() {
        let mut all = models();
        all.push(json!({ "id": "openrouter:p:g/img", "name": "Nano Banana", "capabilities": ["create", "edit"], "source": "cloud", "priceUsd": 0.04, "priceExact": true }));
        let none = json!({});
        assert!(choose(&all[2..], &none, &none, None, "create").unwrap_err().contains("name a cloud model"));
        assert_eq!(choose(&all, &none, &none, None, "edit").unwrap()["id"], "k", "the local editor, not the paid one");
        assert_eq!(
            choose(&all, &json!({ "model": "openrouter:p:g/img" }), &none, None, "create").unwrap()["source"],
            "cloud"
        );
        assert_eq!(choose(&all, &none, &none, Some("openrouter:p:g/img"), "create").unwrap()["source"], "cloud");
        let text = list(&all);
        assert!(text.contains("cloud through OpenRouter, $0.040 a picture, asks before paying"), "{text}");
        assert!(text.contains("- z (Z-Image): create, local, free"), "{text}");
    }

    #[test]
    fn the_settings_default_comes_after_the_chats_own_model() {
        let none = json!({});
        assert_eq!(choose(&models(), &none, &none, Some("k"), "create").unwrap()["id"], "k");
        let chat = json!({ "imageParams": { "modelId": "z" } });
        assert_eq!(choose(&models(), &none, &chat, Some("k"), "create").unwrap()["id"], "z");
        // A default that cannot do the task, or is not ready, is passed over.
        assert_eq!(choose(&models(), &none, &none, Some("z"), "edit").unwrap()["id"], "k");
        assert_eq!(choose(&models(), &none, &none, Some("gone"), "create").unwrap()["id"], "z");
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
        assert!(text.contains("- k (FLUX.2 klein 4B): create, edit, local, free"), "{text}");
        assert!(list(&[]).starts_with("No picture model"));
    }
}
