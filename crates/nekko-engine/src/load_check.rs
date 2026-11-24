//! Whether the llama.cpp engine in use can load a model, for the two reasons
//! that depend on which engine that is. [`launch::unsupported_load_reason`]
//! covers what no engine can do (an image model, a draft model, an unreadable
//! file); this covers what some engines can:
//!
//! 1. **An unknown weight format** (a tensor type past llama.cpp's own, from a
//!    fork such as PrismML's). The engine Nekko Agent installs is stock
//!    llama.cpp and refuses such a file, so a managed engine, or none yet, is
//!    blocked. A `llama-server` the user pointed Nekko Agent at may well be the
//!    modified build the file was made for, so it only gets a warning and
//!    llama.cpp has the last word.
//! 2. **An engine too old for the file** (a header key that needs a minimum
//!    build, `minEngineBuild`). Older builds load such a file without an
//!    error and give wrong output, so the managed engine is blocked when its
//!    release is older (it has an Update). A user's own engine is only warned
//!    about, whether its version reads older or cannot be read: a fork's number
//!    says nothing about upstream's.
//!
//! This is the single source of the decision. The model server's load gate
//! (`server.rs`) refuses a [`Level::Blocked`] check, which covers the Load
//! button, loads on start, the phone and the CLI alike, and the library
//! listing annotates every row with the same check (`loadCheck`), so the apps
//! show the engine's verdict rather than working it out again.

use crate::builds::llama_build_number;
use serde_json::{Value, json};

/// Which engine would run a llama.cpp model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Source {
    /// Nothing installed or configured yet.
    None,
    /// The release Nekko Agent downloaded (stock llama.cpp).
    #[default]
    Managed,
    /// A `llama-server` the user supplied (`engineBinPath`) or that is on PATH.
    External,
}

/// The engine a load would use: where it came from and the version it reports.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EngineInUse {
    pub source: Source,
    /// The release tag the install recorded, or what `--version` printed.
    pub version: Option<String>,
}

impl EngineInUse {
    /// From an install report (`Installer::detect`): `source` and `version`.
    pub fn from_install(install: &Value) -> Self {
        let source =
            match (install.get("binPath").and_then(Value::as_str), install.get("source").and_then(Value::as_str)) {
                (None, _) => Source::None,
                (Some(_), Some("external")) => Source::External,
                (Some(_), _) => Source::Managed,
            };
        let version = install.get("version").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        Self { source, version }
    }

    /// The build number when the version is exactly a llama.cpp tag (`b11224`).
    fn build(&self) -> Option<u64> {
        self.version.as_deref().and_then(llama_build_number)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// The engine cannot load it: the load is refused before llama-server starts.
    Blocked,
    /// It may not load or may misbehave, but the engine gets to try.
    Warning,
}

/// Which rule found it, so the apps can name the fix: no engine update helps
/// a weight format, and one does help an engine that is too old.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    WeightFormat,
    EngineAge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadCheck {
    pub level: Level,
    pub cause: Cause,
    pub reason: String,
}

impl LoadCheck {
    pub fn blocked(&self) -> bool {
        self.level == Level::Blocked
    }

    /// The row's `loadCheck`: `{ level: 'blocked' | 'warning', cause: 'weightFormat' | 'engineAge', reason }`.
    pub fn to_value(&self) -> Value {
        let level = if self.blocked() { "blocked" } else { "warning" };
        let cause = match self.cause {
            Cause::WeightFormat => "weightFormat",
            Cause::EngineAge => "engineAge",
        };
        json!({ "level": level, "cause": cause, "reason": self.reason })
    }
}

/// What the engine in use makes of this model, or `None` when nothing is in the
/// way. A blocking finding beats a warning; between two blocks the weight
/// format is named first, since a newer engine would not help it.
pub fn load_check(model: &Value, engine: &EngineInUse) -> Option<LoadCheck> {
    let name = model.get("name").filter(|n| !n.is_null()).map(nekko_js::display).unwrap_or_else(|| "This model".into());
    let mut found = Vec::new();
    found.extend(weight_format(model, &name, engine));
    found.extend(engine_age(model, &name, engine));
    let blocked = found.iter().position(LoadCheck::blocked);
    match blocked {
        Some(i) => Some(found.swap_remove(i)),
        // Warnings are said together, under the first one's cause.
        None => {
            let cause = found.first()?.cause;
            let reasons: Vec<String> = found.into_iter().map(|c| c.reason).collect();
            Some(LoadCheck { level: Level::Warning, cause, reason: reasons.join(" ") })
        }
    }
}

/// Rule 1: a tensor type llama.cpp does not know.
fn weight_format(model: &Value, name: &str, engine: &EngineInUse) -> Option<LoadCheck> {
    let kind = model.get("unknownWeightType").filter(|t| !t.is_null()).map(nekko_js::display)?;
    let format = format!("{name} stores its weights in a format llama.cpp does not know (GGUF tensor type {kind}).");
    Some(match engine.source {
        Source::External => LoadCheck {
            level: Level::Warning,
            cause: Cause::WeightFormat,
            reason: format!(
                "{format} It needs a modified build of llama.cpp: if your llama-server is not one, loading will fail."
            ),
        },
        Source::Managed | Source::None => LoadCheck {
            level: Level::Blocked,
            cause: Cause::WeightFormat,
            reason: format!(
                "{format} It needs a modified build of llama.cpp, which the engine Nekko Agent installs is not. To run it, point Nekko Agent at a llama-server built for it."
            ),
        },
    })
}

/// Rule 2: the file needs a newer llama.cpp than the engine in use.
fn engine_age(model: &Value, name: &str, engine: &EngineInUse) -> Option<LoadCheck> {
    let needs = model.get("minEngineBuild").and_then(Value::as_u64)?;
    if engine.source == Source::None {
        return None;
    }
    let wants = format!(
        "{name} needs llama.cpp b{needs} or newer. Older builds load it without an error and give wrong output."
    );
    match engine.build() {
        Some(have) if have >= needs => None,
        // The user's own llama-server may be a fork (PrismML's reads these keys)
        // whose number says nothing about upstream's, so it is theirs to try.
        Some(_) if engine.source == Source::External => {
            let version = engine.version.as_deref().unwrap_or_default();
            Some(LoadCheck {
                level: Level::Warning,
                cause: Cause::EngineAge,
                reason: format!(
                    "{wants} The llama-server Nekko Agent is pointed at reports {version}: if it is stock llama.cpp, update it."
                ),
            })
        }
        Some(_) => {
            let version = engine.version.as_deref().unwrap_or_default();
            Some(LoadCheck {
                level: Level::Blocked,
                cause: Cause::EngineAge,
                reason: format!(
                    "{wants} The engine is too old for this file: it is {version}. Update the engine on the Model server card."
                ),
            })
        }
        None => Some(LoadCheck {
            level: Level::Warning,
            cause: Cause::EngineAge,
            reason: format!(
                "{wants} The version of the engine could not be read, so check that it is b{needs} or newer."
            ),
        }),
    }
}
