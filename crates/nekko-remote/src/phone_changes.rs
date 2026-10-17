//! What a paired phone sees of the files the agent changed in a chat: the
//! daemon's copy of `packages/shared/src/phone-changes.ts` (`phoneChangesView`).
//! The limits come from `phone-access.json` (`changesView`), and the phone
//! golden (`tests/golden/phone.json`) holds the output equal to the TS.

use serde_json::{Map, Value, json};

/// `PHONE_CHANGES_VIEW`, as the TS wrote it.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub files: usize,
    pub lines_per_file: usize,
    pub bytes_per_file: usize,
    pub total_bytes: usize,
    pub context: usize,
    pub diff_cells: usize,
}

impl Limits {
    /// From `changesView` in `phone-access.json`; a missing value shows nothing rather than too much.
    pub fn from_policy(v: &Value) -> Limits {
        let n = |k: &str| v[k].as_u64().unwrap_or(0) as usize;
        Limits {
            files: n("files"),
            lines_per_file: n("linesPerFile"),
            bytes_per_file: n("bytesPerFile"),
            total_bytes: n("totalBytes"),
            context: n("context"),
            diff_cells: n("diffCells"),
        }
    }
}

/// `phoneSecretFile`: files whose content never goes to a phone.
pub fn secret_file(path: &str) -> bool {
    let p = path.replace('\\', "/").to_lowercase();
    let name = p.rsplit('/').next().unwrap_or("");
    for dir in [".ssh/", ".aws/", ".gnupg/"] {
        if p.starts_with(dir) || p.contains(&format!("/{dir}")) {
            return true;
        }
    }
    if name.starts_with(".env") || name.starts_with("id_") {
        return true;
    }
    if [".npmrc", ".netrc", ".pypirc", "credentials"].contains(&name) {
        return true;
    }
    [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"].iter().any(|ext| name.ends_with(ext))
}

/// `phoneDisplayPath`: the last two path segments, `…/` first when there were more.
pub fn display_path(path: &str) -> String {
    let norm = path.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 {
        return parts.join("/");
    }
    format!("…/{}", parts[parts.len() - 2..].join("/"))
}

fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<&str> = s.split('\n').collect();
    if out.last() == Some(&"") {
        out.pop();
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Same,
    Removed,
    Added,
}

impl Op {
    fn mark(self) -> char {
        match self {
            Op::Same => ' ',
            Op::Removed => '-',
            Op::Added => '+',
        }
    }
}

/// `lineOps`: the common start and end kept, the middle compared by longest
/// common subsequence (removals first on ties), or removed then added when
/// it is too big to compare.
pub fn line_ops<'a>(a: &[&'a str], b: &[&'a str], cells: usize) -> Vec<(Op, &'a str)> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let ma = &a[pre..a.len() - suf];
    let mb = &b[pre..b.len() - suf];
    let mut ops: Vec<(Op, &str)> = a[..pre].iter().map(|l| (Op::Same, *l)).collect();
    let (n, m) = (ma.len(), mb.len());
    if n.saturating_mul(m) > cells {
        ops.extend(ma.iter().map(|l| (Op::Removed, *l)));
        ops.extend(mb.iter().map(|l| (Op::Added, *l)));
    } else {
        let w = m + 1;
        let mut lcs = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * w + j] = if ma[i] == mb[j] {
                    lcs[(i + 1) * w + j + 1] + 1
                } else {
                    lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && ma[i] == mb[j] {
                ops.push((Op::Same, ma[i]));
                i += 1;
                j += 1;
            } else if j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
                ops.push((Op::Removed, ma[i]));
                i += 1;
            } else {
                ops.push((Op::Added, mb[j]));
                j += 1;
            }
        }
    }
    ops.extend(a[a.len() - suf..].iter().map(|l| (Op::Same, *l)));
    ops
}

/// `hunksOf`: unified-diff hunks with `context` unchanged lines around each change.
pub fn hunks(ops: &[(Op, &str)], context: usize) -> Vec<Value> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (k, (op, _)) in ops.iter().enumerate() {
        if *op == Op::Same {
            continue;
        }
        let start = k.saturating_sub(context);
        let end = (k + context).min(ops.len() - 1);
        match ranges.last_mut() {
            Some(last) if start <= last.1 + 1 => last.1 = last.1.max(end),
            _ => ranges.push((start, end)),
        }
    }
    let (mut old_at, mut new_at) = (Vec::with_capacity(ops.len()), Vec::with_capacity(ops.len()));
    let (mut o, mut nw) = (1usize, 1usize);
    for (op, _) in ops {
        old_at.push(o);
        new_at.push(nw);
        if *op != Op::Added {
            o += 1;
        }
        if *op != Op::Removed {
            nw += 1;
        }
    }
    ranges
        .into_iter()
        .map(|(s, e)| {
            let lines: Vec<String> = ops[s..=e].iter().map(|(op, l)| format!("{}{}", op.mark(), l)).collect();
            json!({ "oldStart": old_at[s], "newStart": new_at[s], "lines": lines })
        })
        .collect()
}

/// `phoneChangesView`: one chat's changes as a phone receives them.
pub fn view(changes: &Value, limits: &Limits) -> Value {
    let list: Vec<&Map<String, Value>> = changes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|c| c.get("path").is_some_and(Value::is_string))
        .collect();
    let mut files: Vec<Value> = Vec::new();
    let (mut total, mut omitted) = (0usize, 0usize);
    for c in list {
        let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
        let (original, current) = (text("original"), text("current"));
        if original == current {
            continue;
        }
        if files.len() >= limits.files {
            omitted += 1;
            continue;
        }
        let path = text("path");
        let (a, b) = (split_lines(original), split_lines(current));
        let ops = line_ops(&a, &b, limits.diff_cells);
        let added = ops.iter().filter(|(op, _)| *op == Op::Added).count();
        let removed = ops.iter().filter(|(op, _)| *op == Op::Removed).count();
        let mut file = Map::new();
        file.insert("path".into(), json!(display_path(path)));
        file.insert("status".into(), json!(if original.is_empty() { "added" } else { "modified" }));
        file.insert("added".into(), json!(added));
        file.insert("removed".into(), json!(removed));
        file.insert("hunks".into(), json!([]));
        if secret_file(path) {
            file.insert("hidden".into(), json!(true));
        } else if original.contains('\u{0}') || current.contains('\u{0}') {
            file.insert("binary".into(), json!(true));
        } else {
            let hs = hunks(&ops, limits.context);
            let line_list = || hs.iter().flat_map(|h| h["lines"].as_array().into_iter().flatten());
            let lines = line_list().count();
            let bytes: usize = line_list().map(|l| l.as_str().map_or(0, str::len)).sum();
            if lines > limits.lines_per_file || bytes > limits.bytes_per_file || total + bytes > limits.total_bytes {
                file.insert("tooLarge".into(), json!(true));
                file.insert("lines".into(), json!(lines));
            } else {
                file.insert("hunks".into(), Value::Array(hs));
                total += bytes;
            }
        }
        files.push(Value::Object(file));
    }
    if omitted > 0 { json!({ "files": files, "omittedFiles": omitted }) } else { json!({ "files": files }) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits {
        files: 50,
        lines_per_file: 400,
        bytes_per_file: 65536,
        total_bytes: 524288,
        context: 3,
        diff_cells: 4_000_000,
    };

    #[test]
    fn a_modified_file_becomes_hunks_with_context() {
        let v = view(
            &json!([{ "path": "/Users/me/work/app/src/main.ts", "original": "a\nb\nc\nd\ne\nf\ng\nh\ni\n", "current": "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\n" }]),
            &LIMITS,
        );
        assert_eq!(
            v,
            json!({ "files": [{ "path": "…/src/main.ts", "status": "modified", "added": 2, "removed": 1,
                "hunks": [{ "oldStart": 2, "newStart": 2, "lines": [" b", " c", " d", "-e", "+E", " f", " g", " h", " i", "+j"] }] }] })
        );
    }

    #[test]
    fn secrets_are_counted_not_shown() {
        for p in ["/w/.env", "/home/u/.ssh/config", "/w/server.pem", "/w/id_ed25519", "/home/u/.aws/credentials"] {
            assert!(secret_file(p), "{p}");
        }
        assert!(!secret_file("/w/src/environment.ts"));
    }

    #[test]
    fn a_region_too_big_to_compare_is_removed_then_added() {
        let ops = line_ops(&["a", "x", "y", "z"], &["a", "p", "q"], 1);
        let marks: Vec<String> = ops.iter().map(|(o, l)| format!("{}{l}", o.mark())).collect();
        assert_eq!(marks, [" a", "-x", "-y", "-z", "+p", "+q"]);
    }
}
