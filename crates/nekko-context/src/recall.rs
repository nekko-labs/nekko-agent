//! Memory recall: which notes a chat's model gets, instead of all of them.
//!
//! - **Core**, in the system prompt for the whole chat: notes tagged
//!   [`CORE_TAG`] (preferences and identity, which apply to every message and
//!   match the words of none) and notes the chat pinned in the Context
//!   Inspector, up to [`CORE_BUDGET_TOKENS`].
//! - **Recalled**, on the message that needs them: the notes whose words best
//!   match the message (bm25 over title, tags and body), up to
//!   [`RECALL_BUDGET_TOKENS`] and [`RECALL_MAX_NOTES`], never one the chat has
//!   already been shown.
//! - **Looked up**, when the model calls `recall_memory` with words of its
//!   own: a note in another language or other words than the message, which
//!   the automatic recall cannot match.
//!
//! Pure Rust and in memory: a heavy user's year is a few hundred to a few
//! thousand short notes. Measured in release on an M-series Mac: 5,000 notes
//! index in 21 ms (only when they change) and a recall takes about 1 ms, a
//! linear scan that is negligible next to a model's reply (#3276). Indexing
//! past chats (episodic memory, #3277) is a different size and would get its
//! own on-disk backend.

use std::collections::{HashMap, HashSet};

use nekko_js as js;
use serde_json::Value;

/// The tag that keeps a note in every chat's system prompt.
pub const CORE_TAG: &str = "always";
/// The most the core may take of the system prompt.
pub const CORE_BUDGET_TOKENS: u64 = 400;
/// The most a message's recalled notes may take.
pub const RECALL_BUDGET_TOKENS: u64 = 300;
/// The most notes one message recalls, or one `recall_memory` call returns.
pub const RECALL_MAX_NOTES: usize = 5;
/// The most one `recall_memory` call returns: the model asked, so more room.
pub const LOOKUP_BUDGET_TOKENS: u64 = 600;

const K1: f64 = 1.2;
const B: f64 = 0.75;
/// A title word counts this many times a body word.
const TITLE_WEIGHT: f64 = 2.0;
/// A query word that only starts a note's word (`deploy` in `deployed`).
const PREFIX_WEIGHT: f64 = 0.5;

/// Words too common to say what a message is about, in the languages the
/// app ships (English, Italian, Spanish, French, German, Portuguese).
const STOPWORDS: &[&str] = &[
    "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "get", "had", "has", "have", "he", "her", "his", "how", "i",
    "if", "in", "into", "is", "it", "its", "just", "me", "my", "no", "not", "now", "of", "on", "or", "our", "please",
    "she", "so", "some", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up",
    "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
    "ai", "al", "alla", "alle", "anche", "che", "chi", "ci", "come", "con", "cosa", "da", "dal", "dei", "del", "della",
    "delle", "di", "e", "gli", "ha", "ho", "il", "io", "la", "le", "lo", "ma", "mi", "mio", "mia", "ne", "nel",
    "nella", "non", "o", "per", "perche", "piu", "quale", "quando", "quello", "questo", "se", "si", "sono", "su",
    "sul", "ti", "tu", "un", "una", "uno", "vorrei", "el", "en", "es", "las", "los", "para", "por", "que", "y", "au",
    "aux", "ce", "dans", "des", "du", "est", "et", "il", "je", "les", "pas", "pour", "qui", "sur", "une", "das", "der",
    "die", "ein", "eine", "ich", "ist", "mit", "nicht", "und", "zu", "em", "os", "um",
];

/// A Latin letter without its accent, so `perché` and `perche` meet.
fn fold(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' => 'y',
        'ś' | 'š' => 's',
        'ź' | 'ż' | 'ž' => 'z',
        'ł' => 'l',
        'ř' => 'r',
        'ť' => 't',
        'ď' => 'd',
        other => other,
    }
}

/// A text's search words: lowercased, accents folded, split on anything that
/// is not a letter or digit, common words and single letters left out.
pub fn terms(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut Vec<String>| {
        if word.chars().count() >= 2 && !STOPWORDS.contains(&word.as_str()) {
            out.push(std::mem::take(word));
        } else {
            word.clear();
        }
    };
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            word.push(fold(c));
        } else {
            flush(&mut word, &mut out);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn tags(note: &Value) -> impl Iterator<Item = &str> {
    note.get("tags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

/// The note's id, as the Context Inspector keys it (`mem:<id>`).
fn inspector_id(note: &Value) -> String {
    format!("mem:{}", text(note, "id"))
}

/// The tokens a note takes in the prompt, as the Context Inspector counts
/// them (a UTF-16 length over four), with its `# Memory` header.
pub fn note_tokens(note: &Value) -> u64 {
    let rendered = js::len16(text(note, "title")) + js::len16(text(note, "body")) + 12;
    rendered.div_ceil(4).max(1) as u64
}

/// Whether the note belongs in every chat's system prompt by its own tag.
pub fn is_core(note: &Value) -> bool {
    tags(note).any(|t| t.trim().eq_ignore_ascii_case(CORE_TAG))
}

/// The core for a new chat: pinned notes first, then the notes tagged
/// [`CORE_TAG`] (newest first, the order `notes` comes in), as many as fit in
/// [`CORE_BUDGET_TOKENS`]. A note the chat switched off (`excluded`) is skipped.
pub fn core_notes(notes: &[Value], pinned: &HashSet<String>, excluded: &HashSet<String>) -> Vec<Value> {
    let wanted = |n: &&Value| !excluded.contains(&inspector_id(n));
    let pins = notes.iter().filter(wanted).filter(|n| pinned.contains(&inspector_id(n)));
    let tagged = notes.iter().filter(wanted).filter(|n| !pinned.contains(&inspector_id(n)) && is_core(n));
    let mut used = 0;
    let mut out = Vec::new();
    for note in pins.chain(tagged) {
        let cost = note_tokens(note);
        if used + cost > CORE_BUDGET_TOKENS {
            continue;
        }
        used += cost;
        out.push(note.clone());
    }
    out
}

struct Doc {
    /// Term frequency, title words weighted [`TITLE_WEIGHT`].
    tf: HashMap<String, f64>,
    len: f64,
}

/// A bm25 index over memory notes, built once per change to the notes.
pub struct MemoryIndex {
    notes: Vec<Value>,
    docs: Vec<Doc>,
    /// How many notes hold each word.
    df: HashMap<String, usize>,
    avg_len: f64,
}

impl MemoryIndex {
    pub fn new(notes: &[Value]) -> Self {
        let mut df: HashMap<String, usize> = HashMap::new();
        let docs: Vec<Doc> = notes
            .iter()
            .map(|n| {
                let mut tf: HashMap<String, f64> = HashMap::new();
                for t in terms(text(n, "title")) {
                    *tf.entry(t).or_default() += TITLE_WEIGHT;
                }
                for tag in tags(n) {
                    for t in terms(tag) {
                        *tf.entry(t).or_default() += 1.0;
                    }
                }
                for t in terms(text(n, "body")) {
                    *tf.entry(t).or_default() += 1.0;
                }
                for t in tf.keys() {
                    *df.entry(t.clone()).or_default() += 1;
                }
                let len = tf.values().sum();
                Doc { tf, len }
            })
            .collect();
        let avg_len = if docs.is_empty() { 1.0 } else { docs.iter().map(|d| d.len).sum::<f64>() / docs.len() as f64 };
        Self { notes: notes.to_vec(), docs, df, avg_len: avg_len.max(1.0) }
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }

    fn idf(&self, term: &str) -> f64 {
        let n = self.docs.len() as f64;
        let df = *self.df.get(term).unwrap_or(&0) as f64;
        ((n - df + 0.5) / (df + 0.5) + 1.0).ln()
    }

    fn weight(&self, doc: &Doc, tf: f64) -> f64 {
        tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * doc.len / self.avg_len))
    }

    /// The notes matching `query`, best first, each with its score. A query
    /// word of four letters or more also matches a word it starts or that
    /// starts it, at a lower weight: a poor man's stemmer, so `deploy`,
    /// `deploys` and `deployment` find each other in any language.
    pub fn search(&self, query: &str) -> Vec<(f64, &Value)> {
        let mut words = terms(query);
        words.sort();
        words.dedup();
        if words.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<(f64, &Value)> = self
            .docs
            .iter()
            .zip(&self.notes)
            .filter_map(|(doc, note)| {
                let mut score = 0.0;
                for q in &words {
                    if let Some(&tf) = doc.tf.get(q) {
                        score += self.idf(q) * self.weight(doc, tf);
                    } else if q.chars().count() >= 4 {
                        // The best word sharing the query word's start, not their sum.
                        let best = doc
                            .tf
                            .iter()
                            .filter(|(t, _)| related(q, t))
                            .map(|(t, &tf)| self.idf(t) * self.weight(doc, tf))
                            .fold(0.0, f64::max);
                        score += PREFIX_WEIGHT * best;
                    }
                }
                (score > 0.0).then_some((score, note))
            })
            .collect();
        hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        hits
    }

    /// What a message recalls: the best matches the chat has not been shown
    /// (`shown` holds note ids) and has not switched off (`excluded` holds
    /// Context Inspector ids), up to [`RECALL_MAX_NOTES`] and
    /// [`RECALL_BUDGET_TOKENS`]. `allowed` limits it to the chat's scope.
    pub fn recall(
        &self,
        query: &str,
        allowed: &HashSet<String>,
        shown: &HashSet<String>,
        excluded: &HashSet<String>,
    ) -> Vec<Value> {
        self.pick(query, allowed, shown, excluded, RECALL_BUDGET_TOKENS)
    }

    /// What the `recall_memory` tool returns: the best matches in the chat's
    /// scope, shown before or not, up to [`RECALL_MAX_NOTES`] and
    /// [`LOOKUP_BUDGET_TOKENS`].
    pub fn lookup(&self, query: &str, allowed: &HashSet<String>, excluded: &HashSet<String>) -> Vec<Value> {
        self.pick(query, allowed, &HashSet::new(), excluded, LOOKUP_BUDGET_TOKENS)
    }

    fn pick(
        &self,
        query: &str,
        allowed: &HashSet<String>,
        shown: &HashSet<String>,
        excluded: &HashSet<String>,
        budget: u64,
    ) -> Vec<Value> {
        let mut used = 0;
        let mut out = Vec::new();
        for (_, note) in self.search(query) {
            let id = text(note, "id");
            if !allowed.contains(id) || shown.contains(id) || excluded.contains(&inspector_id(note)) {
                continue;
            }
            let cost = note_tokens(note);
            if used + cost > budget {
                continue;
            }
            used += cost;
            out.push(note.clone());
            if out.len() >= RECALL_MAX_NOTES {
                break;
            }
        }
        out
    }
}

/// One word starts the other, and the shorter has four letters or more.
fn related(a: &str, b: &str) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    short.chars().count() >= 4 && long.starts_with(short)
}

/// The tail's recalled notes, each under its own header.
pub fn render_recalled(notes: &[Value]) -> String {
    notes
        .iter()
        .map(|n| format!("# Memory recalled: {}\n{}", text(n, "title"), text(n, "body")))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn note(id: &str, title: &str, body: &str, tags: &[&str]) -> Value {
        json!({ "id": id, "scope": "global", "title": title, "body": body, "tags": tags })
    }

    fn ids(notes: &[Value]) -> Vec<&str> {
        notes.iter().map(|n| n["id"].as_str().unwrap()).collect()
    }

    fn notes() -> Vec<Value> {
        vec![
            note("style", "Reply style", "Answer in Italian, briefly.", &["always"]),
            note("deploy", "Deploy", "Deploys go through `fly deploy` from the main branch.", &[]),
            note("editor", "Editor", "The user edits code in Zed.", &[]),
            note("pet", "Cat", "The user has a cat called Miso.", &[]),
        ]
    }

    #[test]
    fn terms_fold_accents_and_drop_common_words() {
        assert_eq!(terms("Perché il DEPLOY è fallito?"), ["deploy", "fallito"]);
        assert_eq!(terms("How do I use the café's API v2"), ["use", "cafe", "api", "v2"]);
    }

    #[test]
    fn the_message_recalls_the_notes_that_match_it_best() {
        let all = notes();
        let index = MemoryIndex::new(&all);
        let allowed: HashSet<String> = all.iter().map(|n| n["id"].as_str().unwrap().to_string()).collect();
        let none = HashSet::new();
        assert_eq!(ids(&index.recall("How do I deploy the app?", &allowed, &none, &none)), ["deploy"]);
        // A word the note only starts with still finds it, below an exact hit.
        assert_eq!(ids(&index.recall("the deployment failed", &allowed, &none, &none)), ["deploy"]);
        assert!(index.recall("what is the weather", &allowed, &none, &none).is_empty());
        // Already shown, switched off, or out of the chat's scope: never again.
        let shown: HashSet<String> = ["deploy".to_string()].into();
        assert!(index.recall("deploy", &allowed, &shown, &none).is_empty());
        let off: HashSet<String> = ["mem:deploy".to_string()].into();
        assert!(index.recall("deploy", &allowed, &none, &off).is_empty());
        let other: HashSet<String> = ["editor".to_string()].into();
        assert!(index.recall("deploy", &other, &none, &none).is_empty());
    }

    #[test]
    fn a_lookup_finds_notes_already_shown_too() {
        let all = notes();
        let index = MemoryIndex::new(&all);
        let allowed: HashSet<String> = all.iter().map(|n| n["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids(&index.lookup("editor code", &allowed, &HashSet::new())), ["editor"]);
        let off: HashSet<String> = ["mem:editor".to_string()].into();
        assert!(index.lookup("editor", &allowed, &off).is_empty());
    }

    #[test]
    fn recall_keeps_to_its_budget() {
        let long = "deploy ".repeat(400);
        let many: Vec<Value> =
            (0..12).map(|i| note(&format!("n{i}"), "Deploy note", "deploy to staging", &[])).collect();
        let allowed: HashSet<String> = (0..12).map(|i| format!("n{i}")).chain(["big".to_string()]).collect();
        let none = HashSet::new();
        let got = MemoryIndex::new(&many).recall("deploy", &allowed, &none, &none);
        assert_eq!(got.len(), RECALL_MAX_NOTES);
        let mut with_big = many.clone();
        with_big.insert(0, note("big", "Deploy", &long, &[]));
        let got = MemoryIndex::new(&with_big).recall("deploy", &allowed, &none, &none);
        assert!(!ids(&got).contains(&"big"), "a note over the whole budget is left to the tool");
        assert!(got.iter().map(note_tokens).sum::<u64>() <= RECALL_BUDGET_TOKENS);
    }

    #[test]
    fn the_core_is_pinned_then_tagged_notes_within_its_budget() {
        let all = notes();
        let none = HashSet::new();
        assert_eq!(ids(&core_notes(&all, &none, &none)), ["style"]);
        let pinned: HashSet<String> = ["mem:pet".to_string()].into();
        assert_eq!(ids(&core_notes(&all, &pinned, &none)), ["pet", "style"]);
        let off: HashSet<String> = ["mem:style".to_string()].into();
        assert!(core_notes(&all, &none, &off).is_empty());
        let crowd: Vec<Value> =
            (0..40).map(|i| note(&format!("c{i}"), "Preference", &"word ".repeat(40), &["Always"])).collect();
        let core = core_notes(&crowd, &none, &none);
        assert!(!core.is_empty() && core.len() < 40);
        assert!(core.iter().map(note_tokens).sum::<u64>() <= CORE_BUDGET_TOKENS);
    }

    #[test]
    fn a_few_thousand_notes_search_fast() {
        let many: Vec<Value> = (0..5000)
            .map(|i| {
                note(&format!("n{i}"), &format!("Fact {i}"), &format!("The user prefers option {i} for staging"), &[])
            })
            .collect();
        let index = MemoryIndex::new(&many);
        let start = std::time::Instant::now();
        for _ in 0..10 {
            assert!(!index.search("option 4321 staging").is_empty());
        }
        // Generous for debug builds and slow CI machines; release is far under.
        assert!(start.elapsed().as_millis() < 2_000, "{:?}", start.elapsed());
    }
}
