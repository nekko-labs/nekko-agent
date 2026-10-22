//! Path resolution and the workspace jail (`resolvePath`, `assertInJail`,
//! `asksEverything` in `packages/host/src/tools.ts`).
//!
//! The jail checks the resolved strings first: a target is inside a root when
//! `relative(root, target)` is empty, or neither starts with `..` nor is
//! absolute. That rule has a quirk kept on purpose: a child literally named
//! `..foo` reads as outside. A target that passes is then checked again on
//! the filesystem: the deepest existing ancestor of the target and of each
//! root are canonicalized, so a symlink or junction inside a workspace that
//! points outside it is refused (issue #550).

use crate::context::{ChatMode, SandboxMode, ToolContext};
use crate::js;
use crate::path::{self, native};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Whether a mutating tool needs an up-front confirm in this mode.
pub fn asks_everything(ctx: &ToolContext) -> bool {
    ctx.mode == ChatMode::Ask || ctx.sandbox_mode == SandboxMode::AskEverything
}

/// The first workspace's path, as settings hold it (not resolved).
pub fn first_workspace(ctx: &ToolContext) -> Option<&str> {
    ctx.workspaces.first().map(|w| w.path.as_str())
}

pub fn process_cwd() -> String {
    path::process_cwd()
}

/// `resolvePath(p)`: absolute paths are normalized, relative ones resolve
/// against the chat's directory, else the first workspace, else the process's.
pub fn resolve_path(p: Option<&Value>, ctx: &ToolContext) -> Result<String, String> {
    let Some(Value::String(p)) = p else { return Err(js::invalid_string_arg("path", p)) };
    let base = ctx.default_cwd.clone().or_else(|| first_workspace(ctx).map(str::to_string)).unwrap_or_else(process_cwd);
    Ok(if native::is_absolute(p) { native::resolve(&[p]) } else { native::resolve(&[&base, p]) })
}

/// The string rule: `relative(root, target)` is empty, or neither starts
/// with `..` nor is absolute.
fn within(root: &str, target: &str) -> bool {
    let rel = native::relative(root, target);
    rel.is_empty() || (!rel.starts_with("..") && !native::is_absolute(&rel))
}

/// `std::fs::canonicalize` without the `\\?\` prefix Windows adds.
fn canonical(p: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(p).ok()?;
    let s = c.to_string_lossy();
    Some(PathBuf::from(
        s.strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()),
    ))
}

/// Where a path really is: its deepest existing ancestor canonicalized (links
/// followed), with the part that does not exist yet appended as given. A path
/// with no existing ancestor at all is returned as is.
fn real_location(p: &str) -> String {
    let mut existing = Path::new(p);
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Some(c) = canonical(existing) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return native::resolve(&[&out.to_string_lossy()]);
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return native::resolve(&[p]),
        }
    }
}

/// `assertInJail(target)`.
pub fn assert_in_jail(target: &str, ctx: &ToolContext) -> Result<(), String> {
    if ctx.sandbox_mode != SandboxMode::WorkspaceJail {
        return Ok(());
    }
    let roots: Vec<String> = ctx.workspaces.iter().map(|w| native::resolve(&[&w.path])).collect();
    // Nothing to jail against yet.
    if roots.is_empty() {
        return Ok(());
    }
    let outside = || {
        Err(format!(
            "Sandbox: {target} is outside the workspace folders. Add the folder or switch sandbox mode in Settings."
        ))
    };
    // Fast first pass on the strings; anything that fails here is outside.
    if !roots.iter().any(|root| within(root, target)) {
        return outside();
    }
    // Then on the filesystem: a link inside a root may point anywhere.
    let real_target = real_location(target);
    if roots.iter().any(|root| within(&real_location(root), &real_target)) { Ok(()) } else { outside() }
}

/// Whether `target` is inside one of the read-only roots, on the strings or
/// once links are followed.
fn in_read_only(target: &str, ctx: &ToolContext) -> bool {
    if ctx.read_only_roots.is_empty() {
        return false;
    }
    let real_target = real_location(target);
    ctx.read_only_roots.iter().any(|r| {
        let root = native::resolve(&[r]);
        within(&root, target) || within(&real_location(&root), &real_target)
    })
}

/// A read: the jail, or one of the read-only roots.
pub fn assert_readable(target: &str, ctx: &ToolContext) -> Result<(), String> {
    if in_read_only(target, ctx) { Ok(()) } else { assert_in_jail(target, ctx) }
}

/// A write: never into a read-only root, then the jail.
pub fn assert_writable(target: &str, ctx: &ToolContext) -> Result<(), String> {
    if in_read_only(target, ctx) {
        return Err(format!("Read-only: {target} is in a folder this chat may read but not change."));
    }
    assert_in_jail(target, ctx)
}
