//! One Nekko turn over a Claude Code session: send the user's message, map
//! the stream until Claude Code's `result`, and handle Stop and Steer.
//!
//! - **Stop** writes the stream-json interrupt and waits for its
//!   `control_response` and the `result` (`terminal_reason:
//!   aborted_streaming`). The process stays up for the next message. Only if
//!   no answer comes within the grace period is the process tree killed (the
//!   chat then resumes with `--resume` next time).
//! - **Steer**: a line written mid-turn is only queued by Claude Code (H0),
//!   so a steering message interrupts the turn, waits for it to end, and is
//!   then sent as the next message, all inside the same Nekko turn.
//!
//! An interrupt's answer is always awaited before anything else is written,
//! so a late interrupt can never cut off the message that follows it.
//!
//! Claude Code also starts turns of its own: when a background command or
//! sub-agent finishes, it wakes and works with nothing written to it. Such a
//! turn's output may still be in the pipe when Nekko writes a message, so a
//! turn ends only at a `result` that comes after Claude Code took the
//! message up (`command_lifecycle` `started`, or its `isReplay` echo); an
//! earlier one belongs to the wake-up and is shown as part of this turn. A
//! turn with no message ([`TurnInput::content`] `None`) is such a wake-up
//! itself, and ends at the next `result`.

use crate::map::{Mapped, Mapper, Outcome, StopKind, TurnEnd, USER_STOPPED, user_content};
use crate::session::{control_error_line, interrupt_line, new_session_id, user_line};
use nekko_loop::{Cancel, Steering};
use serde_json::{Value, json};
use std::future::Future;
use std::io;
use std::time::Duration;
use tokio::time::Instant;

/// How often a running turn looks for steering messages and overdue interrupts.
const TICK: Duration = Duration::from_millis(100);

/// A channel to a Claude Code child: a real [`crate::Session`], or a
/// scripted one in tests.
pub trait Transport: Send {
    /// Write one stream-json line.
    fn send(&mut self, line: Value) -> impl Future<Output = io::Result<()>> + Send;
    /// The next stdout line; `None` once the process is gone.
    fn recv(&mut self) -> impl Future<Output = Option<String>> + Send;
    /// End the process tree (the Stop fallback).
    fn kill(&mut self);
    /// A fresh control `request_id`.
    fn next_request_id(&mut self) -> String;
    /// What to tell the user when the process went away (exit code, stderr tail).
    fn diagnostics(&mut self) -> String;
    /// Whether this child reports `command_lifecycle` for the messages it is
    /// sent (learned from the first one; an older Claude Code may not).
    fn reports_commands(&self) -> bool {
        false
    }
    fn set_reports_commands(&mut self) {}
}

pub struct TurnInput<'a> {
    /// The user's message, as stream-json content ([`user_content`]); `None`
    /// for a turn Claude Code started on its own (a wake-up), which is only read.
    pub content: Option<Value>,
    pub cancel: &'a Cancel,
    pub steering: &'a Steering,
    /// How long an interrupt may go unanswered before the tree is killed.
    pub interrupt_grace: Duration,
    /// An MCP server that must be connected before Claude Code may act (the
    /// approval bridge). If it is not, the process is ended before any model
    /// call: permissions fail closed.
    pub require_mcp: Option<&'a str>,
}

/// How the turn ended, for the session that ran it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnExit {
    Completed,
    /// The user's Stop was honoured; the process is still up.
    Stopped,
    /// Claude Code ended the turn with an error; the process is still up.
    Failed,
    /// The process is gone or was killed: relaunch with `--resume`.
    Dead,
}

struct Stop {
    kind: StopKind,
    id: String,
    deadline: Instant,
    acked: bool,
}

fn take_steering(steering: &Steering) -> Vec<Value> {
    std::mem::take(&mut *steering.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Steering messages back where Nekko queues what a turn left (the turn's end).
fn give_back(steering: &Steering, mut messages: Vec<Value>) {
    if messages.is_empty() {
        return;
    }
    let mut s = steering.lock().unwrap_or_else(|e| e.into_inner());
    messages.append(&mut s);
    *s = messages;
}

/// Several steering messages sent as one: their text joined.
fn steer_content(messages: &[Value]) -> Value {
    if let [one] = messages {
        return user_content(one);
    }
    let text: Vec<String> = messages
        .iter()
        .map(|m| match user_content(m) {
            Value::String(s) => s,
            other => other.to_string(),
        })
        .collect();
    json!(text.join("\n\n"))
}

/// Drive one Nekko turn to its end. Every mapped item goes to `emit` in
/// order (events, transcript messages, `Init` for the session id).
pub async fn run_turn<T: Transport>(
    t: &mut T,
    mapper: &mut Mapper,
    input: TurnInput<'_>,
    emit: &mut (dyn FnMut(Mapped) + Send),
) -> TurnExit {
    // The message Claude Code has not taken up yet: until it has, a `result`
    // ends a turn it started on its own.
    let mut awaiting: Option<String> = None;
    if let Some(content) = input.content.clone() {
        let uuid = new_session_id();
        if t.send(user_line(content, &uuid)).await.is_err() {
            let why = t.diagnostics();
            mapper.fail(&why).into_iter().for_each(&mut *emit);
            return TurnExit::Dead;
        }
        awaiting = Some(uuid);
    }
    let mut stop: Option<Stop> = None;
    // A `result` that arrived before its interrupt was answered.
    let mut ended: Option<TurnEnd> = None;
    // Steering messages waiting for the turn to make room.
    let mut steer: Vec<Value> = Vec::new();
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    macro_rules! begin_stop {
        ($kind:expr) => {{
            let kind = $kind;
            match stop.as_mut() {
                // Already interrupting: a Stop upgrades a Steer, nothing is resent.
                Some(s) => {
                    if kind == StopKind::User {
                        s.kind = StopKind::User;
                        mapper.expect_stop(StopKind::User);
                    }
                }
                None => {
                    let id = t.next_request_id();
                    mapper.expect_stop(kind);
                    stop = Some(Stop {
                        kind,
                        id: id.clone(),
                        deadline: Instant::now() + input.interrupt_grace,
                        acked: false,
                    });
                    if t.send(interrupt_line(&id)).await.is_err() {
                        // Nothing can answer: the deadline kills it.
                        if let Some(s) = stop.as_mut() {
                            s.deadline = Instant::now();
                        }
                    }
                }
            }
        }};
    }

    loop {
        let stopping_for_user = stop.as_ref().is_some_and(|s| s.kind == StopKind::User);
        let line = tokio::select! {
            biased;
            _ = input.cancel.cancelled(), if !stopping_for_user => {
                begin_stop!(StopKind::User);
                continue;
            }
            l = t.recv() => l,
            _ = tick.tick() => {
                if stop.is_none() && ended.is_none() {
                    let more = take_steering(input.steering);
                    if !more.is_empty() {
                        steer.extend(more);
                        begin_stop!(StopKind::Steer);
                    }
                }
                let overdue = stop.as_ref().is_some_and(|s| Instant::now() >= s.deadline);
                if !overdue {
                    continue;
                }
                if let Some(end) = ended.take() {
                    // Claude Code finished but never answered the interrupt;
                    // the turn is over all the same.
                    let kind = stop.take().map(|s| s.kind);
                    match settle(t, mapper, &input, end, kind, &mut steer, &mut awaiting, emit).await {
                        Some(exit) => return exit,
                        None => continue,
                    }
                }
                // No answer to the interrupt: end the tree (the fallback).
                let kind = stop.take().map_or(StopKind::User, |s| s.kind);
                t.kill();
                mapper.flush(true, kind == StopKind::User).into_iter().for_each(&mut *emit);
                if kind == StopKind::User {
                    mapper.fail(USER_STOPPED).into_iter().for_each(&mut *emit);
                } else {
                    give_back(input.steering, std::mem::take(&mut steer));
                    let why = format!("Claude Code did not stop for your new message, so it was ended. {}", t.diagnostics());
                    mapper.fail(&why).into_iter().for_each(&mut *emit);
                }
                return TurnExit::Dead;
            }
        };
        let Some(line) = line else {
            // The process is gone.
            let user = stopping_for_user || input.cancel.is_cancelled();
            mapper.flush(true, true).into_iter().for_each(&mut *emit);
            give_back(input.steering, std::mem::take(&mut steer));
            let why = if user { USER_STOPPED.to_string() } else { t.diagnostics() };
            mapper.fail(&why).into_iter().for_each(&mut *emit);
            return TurnExit::Dead;
        };
        for item in mapper.map_line(&line) {
            match item {
                Mapped::Init(init) => {
                    let missing = input.require_mcp.filter(|name| !init.connected(name)).map(str::to_string);
                    emit(Mapped::Init(init));
                    if let Some(name) = missing {
                        t.kill();
                        give_back(input.steering, std::mem::take(&mut steer));
                        let why = format!(
                            "Nekko's approval bridge ({name}) did not connect, so Claude Code was stopped before it could act. Nothing ran."
                        );
                        mapper.fail(&why).into_iter().for_each(&mut *emit);
                        return TurnExit::Dead;
                    }
                }
                Mapped::ControlResponse { request_id, error } => {
                    let Some(s) = stop.as_mut().filter(|s| s.id == request_id) else { continue };
                    if error.is_some() {
                        // Refused: the deadline's fallback ends it now.
                        s.deadline = Instant::now();
                        continue;
                    }
                    s.acked = true;
                    // The `result` follows the answer; give it the same grace again.
                    s.deadline = Instant::now() + input.interrupt_grace;
                    if let Some(end) = ended.take() {
                        let kind = stop.take().map(|s| s.kind);
                        if let Some(exit) = settle(t, mapper, &input, end, kind, &mut steer, &mut awaiting, emit).await
                        {
                            return exit;
                        }
                    }
                }
                Mapped::Command { uuid, state } => {
                    t.set_reports_commands();
                    if awaiting.as_deref() == Some(uuid.as_str()) && state != "queued" {
                        awaiting = None;
                    }
                }
                Mapped::ControlRequest { request_id, subtype } => {
                    let why = format!("Nekko Agent does not handle {subtype} requests.");
                    let _ = t.send(control_error_line(&request_id, &why)).await;
                }
                Mapped::End(end) => {
                    if stop.is_none() && awaiting.is_some() && t.reports_commands() {
                        // A turn Claude Code started on its own ended before it
                        // took up this one's message: keep reading.
                        if let Some(u) = &end.usage {
                            emit(mapper.event("usage", u.clone()));
                        }
                        continue;
                    }
                    if stop.as_ref().is_some_and(|s| !s.acked) {
                        // Wait for the interrupt's answer before writing anything.
                        ended = Some(end);
                        continue;
                    }
                    let kind = stop.take().map(|s| s.kind);
                    if let Some(exit) = settle(t, mapper, &input, end, kind, &mut steer, &mut awaiting, emit).await {
                        return exit;
                    }
                }
                other => emit(other),
            }
        }
    }
}

/// A Claude Code turn ended. With steering waiting (and no Stop), send it as
/// the next message and keep going (`None`); otherwise end the Nekko turn.
#[allow(clippy::too_many_arguments)]
async fn settle<T: Transport>(
    t: &mut T,
    mapper: &mut Mapper,
    input: &TurnInput<'_>,
    end: TurnEnd,
    kind: Option<StopKind>,
    steer: &mut Vec<Value>,
    awaiting: &mut Option<String>,
    emit: &mut (dyn FnMut(Mapped) + Send),
) -> Option<TurnExit> {
    let user_stop = kind == Some(StopKind::User) || input.cancel.is_cancelled();
    let failed = matches!(end.outcome, Outcome::Failed(_));
    if !user_stop && !failed {
        steer.extend(take_steering(input.steering));
    }
    if user_stop || failed || steer.is_empty() {
        give_back(input.steering, std::mem::take(steer));
        let mut end = end;
        if kind == Some(StopKind::Steer) && end.outcome == Outcome::Interrupted {
            // Steering that found nothing to send ends like any reply.
            end.outcome = Outcome::Completed;
        }
        mapper.finish(&end).into_iter().for_each(&mut *emit);
        return Some(match end.outcome {
            Outcome::Completed => TurnExit::Completed,
            Outcome::Interrupted => TurnExit::Stopped,
            Outcome::Failed(_) => TurnExit::Failed,
        });
    }
    // Keep the tokens of the part that ran, then fold the steering in.
    if let Some(u) = &end.usage {
        emit(mapper.event("usage", u.clone()));
    }
    let messages = std::mem::take(steer);
    let content = steer_content(&messages);
    for m in messages {
        let id = m.get("id").cloned().unwrap_or(Value::Null);
        emit(Mapped::Message(m));
        emit(mapper.event("steered", json!({ "messageId": id })));
    }
    let uuid = new_session_id();
    if t.send(user_line(content, &uuid)).await.is_err() {
        let why = t.diagnostics();
        mapper.fail(&why).into_iter().for_each(&mut *emit);
        return Some(TurnExit::Dead);
    }
    *awaiting = Some(uuid);
    None
}
