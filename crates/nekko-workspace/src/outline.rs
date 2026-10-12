//! The indexer's file rules and symbol outline, ported from
//! `packages/core/src/indexer` (`IGNORED_DIRS`, `isIndexable`,
//! `detectLanguage`, `extractOutline`).

use regress::Regex;
use std::sync::OnceLock;

/// Directories (and dot-names) the indexer always skips.
pub const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "out",
    "build",
    ".next",
    ".nuxt",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "coverage",
    ".idea",
    ".vscode",
    "vendor",
    ".turbo",
    "release",
];

const BINARY_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar", "exe", "dll", "so", "dylib", "woff",
    "woff2", "ttf", "mp4", "mp3", "wav", "bin",
];

/// `path.split('.').pop()?.toLowerCase()`: everything after the last dot of
/// the whole string, or the whole string when it has none.
fn last_ext(path: &str) -> String {
    path.rsplit('.').next().unwrap_or(path).to_lowercase()
}

/// `isIndexable(name)`.
pub fn is_indexable(path: &str) -> bool {
    let ext = last_ext(path);
    ext.is_empty() || !BINARY_EXT.contains(&ext.as_str())
}

/// `detectLanguage(path)`.
pub fn detect_language(path: &str) -> Option<&'static str> {
    Some(match last_ext(path).as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" => "javascript",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "rb" => "ruby",
        "php" => "php",
        "cs" => "csharp",
        "cpp" => "cpp",
        "c" | "h" => "c",
        "swift" => "swift",
        "kt" => "kotlin",
        "md" => "markdown",
        "json" => "json",
        "css" => "css",
        "html" => "html",
        "vue" => "vue",
        "sh" => "shell",
        _ => return None,
    })
}

/// One `CodeSymbol`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub kind: &'static str,
    pub line: usize,
}

struct Pattern {
    re: Regex,
    kind: &'static str,
}

fn compile(list: &[(&str, &'static str)]) -> Vec<Pattern> {
    list.iter().map(|(re, kind)| Pattern { re: Regex::new(re).expect("outline pattern compiles"), kind }).collect()
}

fn patterns(language: &str) -> Option<&'static [Pattern]> {
    static TS: OnceLock<Vec<Pattern>> = OnceLock::new();
    static PY: OnceLock<Vec<Pattern>> = OnceLock::new();
    static RS: OnceLock<Vec<Pattern>> = OnceLock::new();
    static GO: OnceLock<Vec<Pattern>> = OnceLock::new();
    Some(match language {
        "typescript" | "javascript" => TS.get_or_init(|| {
            compile(&[
                (r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)", "function"),
                (r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)", "class"),
                (r"^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)", "interface"),
                (r"^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=", "type"),
                (r"^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(", "function"),
                (r"^\s*(?:export\s+)?const\s+([A-Z][A-Za-z0-9_$]*)\s*=", "const"),
            ])
        }),
        "python" => PY.get_or_init(|| {
            compile(&[(r"^\s*def\s+([A-Za-z0-9_]+)", "function"), (r"^\s*class\s+([A-Za-z0-9_]+)", "class")])
        }),
        "rust" => RS.get_or_init(|| {
            compile(&[
                (r"^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)", "function"),
                (r"^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)", "class"),
                (r"^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)", "interface"),
            ])
        }),
        "go" => GO.get_or_init(|| {
            compile(&[
                (r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)", "function"),
                (r"^\s*type\s+([A-Za-z0-9_]+)\s+struct", "class"),
            ])
        }),
        _ => return None,
    })
}

/// `extractOutline(source, language)`: the first matching pattern per line,
/// lines longer than 400 UTF-16 units skipped.
pub fn extract_outline(source: &str, language: Option<&str>) -> Vec<Symbol> {
    let Some(patterns) = language.and_then(patterns) else { return Vec::new() };
    let mut out = Vec::new();
    for (i, line) in source.split('\n').enumerate() {
        if nekko_js::len16(line) > 400 {
            continue;
        }
        for p in patterns {
            if let Some(m) = p.re.find(line)
                && let Some(g) = m.group(1)
                && !g.is_empty()
            {
                out.push(Symbol { name: line[g].to_string(), kind: p.kind, line: i + 1 });
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_extensions_off_the_whole_string() {
        assert!(is_indexable("Makefile"));
        assert!(!is_indexable("png"));
        assert!(!is_indexable("a.PNG"));
        assert!(is_indexable("a."));
        assert_eq!(detect_language("/a.b/Makefile"), None);
        assert_eq!(detect_language("x/y.TSX"), Some("typescript"));
    }

    #[test]
    fn outlines_typescript_and_go() {
        let src = "export default async function main() {}\n  export const Foo = 1\nconst go = async (x) => x\nexport type T = {}";
        let names: Vec<_> =
            extract_outline(src, Some("typescript")).into_iter().map(|s| (s.name, s.kind, s.line)).collect();
        assert_eq!(
            names,
            [
                ("main".into(), "function", 1),
                ("Foo".into(), "const", 2),
                ("go".into(), "function", 3),
                ("T".into(), "type", 4)
            ]
        );
        let go = extract_outline("func (s *S) Run() {}\ntype S struct {}", Some("go"));
        assert_eq!((go[0].name.as_str(), go[1].kind), ("Run", "class"));
    }
}
