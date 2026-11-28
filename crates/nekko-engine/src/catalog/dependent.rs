//! Resolve a companion separately from the catalog's ordinary build ladder.
use super::*;

const GGUF_DRAFT: &str = "incoai/Qwen3.8-27B-DFlash2-GGUF";
const MLX_DRAFT: &str = "incoai/Qwen3.8-27B-DFlash2";
const STOCK: &str = "Qwen/Qwen3.8-27B";

pub(super) fn hint(s: &str) -> bool {
    test(regex!(r"(^|[-_./ ])(lora|adapter|dflash2?|draft-model|peft)([-_./ ]|$)", "i"), s)
}

pub(super) fn draft_arch(s: &str) -> bool {
    test(regex!(r"dflash|eagle|medusa|lookahead|speculative|draft", "i"), s)
}

pub(super) fn dependent_hint(id: &str, tags: &[String], quants: &[Value]) -> bool {
    hint(id) || tags.iter().any(|t| hint(t)) || (!quants.is_empty() && quants.iter().all(|q| q["dependent"] == true))
}

fn artifact(repo: &str, q: &Value) -> Option<Value> {
    Some(json!({ "repo": repo, "quant": q["label"].as_str()?, "file": q["file"].as_str()?,
        "sizeBytes": q["sizeBytes"].as_u64().filter(|n| *n > 0)? }))
}

fn healthy(row: &Value) -> bool {
    row["readable"] != false
        && row["loadCheck"]["level"] != "blocked"
        && row["unknownWeightType"].is_null()
        && row["dependentWeights"] != true
        && row["companion"].is_null()
        && row["id"].is_string()
}

fn installed_draft_base(row: &Value, mlx: bool) -> bool {
    if !healthy(row) {
        return false;
    }
    if mlx {
        let path = row["path"].as_str().unwrap_or_default();
        let path = std::path::Path::new(path);
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        let snapshot_repo = path
            .parent()
            .filter(|p| p.ends_with("snapshots"))
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("models--mlx-community--"));
        let stock_name = snapshot_repo.unwrap_or_else(|| name.strip_prefix("mlx-community_").unwrap_or(name));
        row["format"] == "mlx"
            && row["mlxRunnable"] == true
            && row["architecture"] == "qwen3_5"
            && row["modality"] == "vision"
            && matches!(
                stock_name,
                "Qwen3.8-27B" | "Qwen3.8-27B-4bit" | "Qwen3.8-27B-8bit" | "Qwen3.8-27B-MLX-8bit" | "Qwen3.8-27B-bf16"
            )
    } else {
        row["format"] != "mlx"
            && row["architecture"] == "qwen35"
            && row["layers"].as_f64() == Some(64.0)
            && matches!(row["name"].as_str(), Some(n) if n.eq_ignore_ascii_case("Qwen3.8-27B") || n.eq_ignore_ascii_case("Qwen3.8 27B"))
    }
}

impl Catalog {
    /// Size of the whole base download, including required projector and config files.
    async fn base_artifact(&self, repo: &str, q: &Value) -> Option<Value> {
        let mut out = artifact(repo, q)?;
        if q["format"] == "mlx" || q["extraFiles"].as_array().is_none_or(Vec::is_empty) {
            return Some(out);
        }
        let tree = tree_files(&self.tree_for(repo).await?);
        let size = std::iter::once(q["file"].as_str()?)
            .chain(q["extraFiles"].as_array()?.iter().filter_map(Value::as_str))
            .try_fold(0.0, |total, file| {
                Some(total + tree.iter().find(|f| !f.is_dir && f.size > 0.0 && f.path.as_deref() == Some(file))?.size)
            })?;
        out["sizeBytes"] = crate::num(size);
        Some(out)
    }

    /// Resolve only when a build has been identified as dependent. No names are used as
    /// proof for LoRA: the adapter must identify a single exact repo in its GGUF metadata.
    pub async fn companion(&self, model: &Value, q: &Value, library: &[Value], check_unmarked: bool) -> Option<Value> {
        let id = gguf::repo_id(model["id"].as_str()?)?;
        let file = q["file"].as_str()?;
        let mlx = q["format"] == "mlx";
        let known_draft = (mlx && id == MLX_DRAFT) || (!mlx && id == GGUF_DRAFT);
        let hinted = known_draft || model["dependent"] == true || q["dependent"] == true;
        let facts = if mlx {
            None
        } else if hinted || check_unmarked {
            self.file_facts(id, file).await
        } else {
            self.known_facts(id, file)
        };
        let arch = facts.as_ref().and_then(|f| f["architecture"].as_str()).unwrap_or("");
        let unsupported = |reason: &str| Some(json!({ "kind": "unsupported", "reason": reason }));
        let installed = |m: &Value| json!({ "id": m["id"], "name": m["name"] });
        if known_draft {
            // These are the published stock pairings measured in docs/local-models.md.
            // GGUF still needs to be a real head; the MLX folder is selected by exact repo.
            if !mlx && (arch != "dflash" || facts.as_ref().is_some_and(|f| !f["unknownWeightType"].is_null())) {
                return unsupported("Could not verify this DFlash2 build.");
            }
            let mut out = json!({ "kind": "draft", "baseRepo": STOCK });
            if let Some(m) = library.iter().find(|m| installed_draft_base(m, mlx)) {
                out["installedBase"] = installed(m);
            } else {
                let repo = if mlx { "mlx-community/Qwen3.8-27B-4bit" } else { "ggml-org/Qwen3.8-27B-GGUF" };
                let base = self.model(repo).await;
                let build = base["quants"].as_array().into_iter().flatten().find(|q| {
                    if mlx {
                        q["format"] == "mlx" && q["label"] == "4bit"
                    } else {
                        q["file"] == "Qwen3.8-27B-Q4_K_M.gguf"
                    }
                });
                if let Some(build) = build
                    && let Some(a) = self.base_artifact(repo, build).await
                {
                    out["base"] = a;
                } else {
                    out["reason"] = json!("The stock base build is not available from the catalog.");
                }
            }
            return Some(out);
        }
        if !facts.as_ref().is_some_and(|f| f["lora"] == true) {
            return (hinted || draft_arch(arch) || facts.as_ref().is_some_and(|f| f["adapter"] == true))
                .then(|| {
                    unsupported(if mlx {
                        "Only the published DFlash2 pairing is supported for MLX companion weights."
                    } else {
                        "No supported companion and compatible base could be verified for this build."
                    })
                })
                .flatten();
        }
        let facts = facts.as_ref()?;
        if arch.is_empty()
            || !facts["unknownWeightType"].is_null()
            || test(regex!(r"-\d{5}-of-\d{5}\.gguf$", "i"), file)
        {
            return unsupported("This LoRA build is not supported by the local GGUF runtime.");
        }
        let Some(repo) = facts["adapterBaseRepo"].as_str().and_then(gguf::repo_id).filter(|r| *r != id) else {
            return Some(
                json!({ "kind": "lora", "reason": "This adapter does not identify one exact base checkpoint in its GGUF header." }),
            );
        };
        let mut out = json!({ "kind": "lora", "baseRepo": repo });
        if let Some(m) = library.iter().find(|m| {
            healthy(m)
                && m["format"] != "mlx"
                && m["loraBaseRepo"] == repo
                && m["architecture"] == arch
                && matches!(m["modality"].as_str(), Some("chat" | "vision" | "embedding"))
        }) {
            out["installedBase"] = installed(m);
        } else if let Some(base) = self.lora_base(repo, id, arch).await {
            out["base"] = base;
        } else {
            out["reason"] = json!("No downloadable GGUF build of the exact base checkpoint could be verified.");
        }
        Some(out)
    }

    async fn lora_base(&self, repo: &str, adapter: &str, arch: &str) -> Option<Value> {
        let mut repos = vec![repo.to_string()];
        // The checkpoint may publish only Transformers files. Discover declared GGUF conversions,
        // then require header provenance; a Hub tag or a similar name isn't enough.
        let filter = encode_uri_component(&format!("base_model:quantized:{repo}"));
        if let Some(Value::Array(rows)) = self
            .get_json(format!("{HF_API}/models?filter=gguf&filter={filter}&sort=downloads&direction=-1&limit=5"))
            .await
        {
            for r in rows {
                if let Some(id) = r["id"].as_str().and_then(gguf::repo_id).filter(|id| *id != repo && *id != adapter) {
                    repos.push(id.to_string());
                }
            }
        }
        for id in repos {
            let model = self.model(&id).await;
            let mut builds: Vec<&Value> = model["quants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|q| q["format"] != "mlx" && q["dependent"] != true && artifact(&id, q).is_some())
                .collect();
            builds.sort_by_key(|q| q["sizeBytes"].as_u64().unwrap_or(u64::MAX));
            for q in builds.into_iter().take(2) {
                let Some(f) = self.file_facts(&id, q["file"].as_str()?).await else { continue };
                if f["architecture"] == arch
                    && f["adapter"] != true
                    && f["unknownWeightType"].is_null()
                    && (f["sourceRepo"] == repo || (id == repo && f["sourceRepo"].is_null()))
                {
                    if let Some(base) = self.base_artifact(&id, q).await {
                        return Some(base);
                    }
                }
            }
        }
        None
    }
}
