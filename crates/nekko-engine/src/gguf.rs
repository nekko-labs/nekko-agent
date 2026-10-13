//! A GGUF header reader, just far enough to answer the fit planner's
//! questions. A port of `packages/host/src/engine/gguf.ts`, held to it by
//! `tests/golden/library.json`.
//!
//! Format (v2/v3): a 4-byte magic, a u32 version, a u64 tensor count, a u64
//! metadata-pair count, then that many pairs of (string key, u32 type, value).
//! Keys are architecture-prefixed (`llama.block_count`), so lookups match on
//! the suffix.

use crate::num;
use serde_json::{Map, Value};
use std::io::Read;

const MAGIC: u32 = 0x4655_4747;
/// Metadata sits at the front; a model whose header exceeds this is malformed.
const MAX_HEADER_BYTES: usize = 16 * 1024 * 1024;
const FIRST_READ: usize = 4 * 1024 * 1024;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// What the header says, in the TS field order (`GgufMetadata`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GgufMetadata {
    pub architecture: Option<String>,
    pub name: Option<String>,
    pub layers: Option<f64>,
    pub kv_heads: Option<f64>,
    pub head_dim: Option<f64>,
    pub max_context: Option<f64>,
    pub quantization: Option<String>,
    pub parameter_size: Option<String>,
    pub chat_template: Option<String>,
}

impl GgufMetadata {
    /// The object `readGgufMetadata` resolves to, as JSON prints it.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        let text = |m: &mut Map<String, Value>, k: &str, v: &Option<String>| {
            if let Some(v) = v {
                m.insert(k.into(), Value::String(v.clone()));
            }
        };
        let number = |m: &mut Map<String, Value>, k: &str, v: Option<f64>| {
            if let Some(v) = v {
                m.insert(k.into(), num(v));
            }
        };
        text(&mut m, "architecture", &self.architecture);
        text(&mut m, "name", &self.name);
        number(&mut m, "layers", self.layers);
        number(&mut m, "kvHeads", self.kv_heads);
        number(&mut m, "headDim", self.head_dim);
        number(&mut m, "maxContext", self.max_context);
        text(&mut m, "quantization", &self.quantization);
        text(&mut m, "parameterSize", &self.parameter_size);
        text(&mut m, "chatTemplate", &self.chat_template);
        Value::Object(m)
    }
}

/// `general.file_type` values, mapped to the familiar quant names.
fn file_type(n: f64) -> Option<&'static str> {
    if n.fract() != 0.0 {
        return None;
    }
    Some(match n as i64 {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        7 => "Q8_0",
        8 => "Q5_0",
        9 => "Q5_1",
        10 => "Q2_K",
        11 => "Q3_K_S",
        12 => "Q3_K_M",
        13 => "Q3_K_L",
        14 => "Q4_K_S",
        15 => "Q4_K_M",
        16 => "Q5_K_S",
        17 => "Q5_K_M",
        18 => "Q6_K",
        19 => "IQ2_XXS",
        20 => "IQ2_XS",
        21 => "Q2_K_S",
        22 => "IQ3_XS",
        23 => "IQ3_XXS",
        24 => "IQ1_S",
        25 => "IQ4_NL",
        26 => "IQ3_S",
        27 => "IQ3_M",
        28 => "IQ2_S",
        29 => "IQ2_M",
        30 => "IQ4_XS",
        31 => "IQ1_M",
        32 => "BF16",
        36 => "TQ1_0",
        37 => "TQ2_0",
        38 => "MXFP4",
        _ => return None,
    })
}

/// Read a GGUF file's metadata, or `None` when it is not a readable GGUF.
/// Never fails: a truncated download and a renamed JPEG are both "unreadable".
pub fn read_metadata(path: &str) -> Option<GgufMetadata> {
    let mut file = std::fs::File::open(path).ok()?;
    let head = read_up_to(&mut file, FIRST_READ)?;
    if head.len() < 24 {
        return None;
    }
    match parse(&head) {
        Parsed::Done(m) => m,
        Parsed::Truncated => {
            // A big vocabulary can push the geometry keys past the first read.
            let mut file = std::fs::File::open(path).ok()?;
            let wide = read_up_to(&mut file, MAX_HEADER_BYTES)?;
            match parse(&wide) {
                Parsed::Done(m) => m,
                Parsed::Truncated => None,
            }
        }
    }
}

fn read_up_to(file: &mut std::fs::File, n: usize) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(n.min(1 << 20));
    file.take(n as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

enum Parsed {
    Done(Option<GgufMetadata>),
    Truncated,
}

enum Stop {
    Eof,
    Bad,
}

/// A scalar or string value; arrays are skipped.
#[derive(Clone)]
enum Val {
    Num(f64),
    Str(String),
}

/// Parse a header buffer.
fn parse(buf: &[u8]) -> Parsed {
    let u32_at = |at: usize| u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
    if u32_at(0) != MAGIC {
        return Parsed::Done(None);
    }
    let version = u32_at(4);
    if !(2..=3).contains(&version) {
        return Parsed::Done(None);
    }
    let mut r = Reader { buf, at: 8 };
    let read = |r: &mut Reader| -> Result<Option<Vec<(String, Val)>>, Stop> {
        r.u64()?; // tensor count
        let pairs = r.u64()? as f64;
        if pairs > MAX_SAFE || pairs > 100_000.0 {
            return Ok(None);
        }
        // A JavaScript Map: a repeated key keeps its first place and takes the new value.
        let mut kv: Vec<(String, Val)> = Vec::new();
        for _ in 0..pairs as u64 {
            let key = r.string()?;
            if let Some(value) = r.value()? {
                match kv.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = value,
                    None => kv.push((key, value)),
                }
            }
        }
        Ok(Some(kv))
    };
    match read(&mut r) {
        Ok(None) => Parsed::Done(None),
        Ok(Some(kv)) => Parsed::Done(Some(to_metadata(&kv))),
        Err(Stop::Eof) => Parsed::Truncated,
        Err(Stop::Bad) => Parsed::Done(None),
    }
}

fn to_metadata(kv: &[(String, Val)]) -> GgufMetadata {
    let heads = num_of(kv, "attention.head_count");
    let embedding = num_of(kv, "embedding_length");
    let head_dim = num_of(kv, "attention.key_length").or(match (embedding, heads) {
        (Some(e), Some(h)) => Some(e / h),
        _ => None,
    });
    let file_type_id = num_of(kv, "general.file_type");
    GgufMetadata {
        architecture: str_of(kv, "general.architecture"),
        name: str_of(kv, "general.name"),
        layers: num_of(kv, "block_count"),
        kv_heads: num_of(kv, "attention.head_count_kv").or(heads),
        head_dim: head_dim.filter(|d| d.is_finite() && *d != 0.0),
        max_context: num_of(kv, "context_length"),
        quantization: file_type_id
            .map(|t| file_type(t).map_or_else(|| format!("type {}", nekko_js::number_to_string(t)), str::to_string)),
        parameter_size: str_of(kv, "general.size_label"),
        chat_template: str_of(kv, "tokenizer.chat_template"),
    }
}

/// Exact key, else the first architecture-prefixed one (`llama.block_count`).
fn pick<'a>(kv: &'a [(String, Val)], suffix: &str) -> Option<&'a Val> {
    if let Some((_, v)) = kv.iter().find(|(k, _)| k == suffix) {
        return Some(v);
    }
    let dotted = format!(".{suffix}");
    kv.iter().find(|(k, _)| k.ends_with(&dotted)).map(|(_, v)| v)
}

fn num_of(kv: &[(String, Val)], suffix: &str) -> Option<f64> {
    match pick(kv, suffix) {
        Some(Val::Num(n)) if n.is_finite() && *n > 0.0 => Some(*n),
        _ => None,
    }
}

fn str_of(kv: &[(String, Val)], suffix: &str) -> Option<String> {
    match pick(kv, suffix) {
        Some(Val::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// A cursor over the header bytes: `Eof` means "the header is longer than
/// what was read", `Bad` means "this is not a GGUF".
struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn need(&mut self, n: f64) -> Result<usize, Stop> {
        if self.at as f64 + n > self.buf.len() as f64 {
            return Err(Stop::Eof);
        }
        let start = self.at;
        self.at += n as usize;
        Ok(start)
    }

    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], Stop> {
        let at = self.need(N as f64)?;
        let mut out = [0u8; N];
        out.copy_from_slice(&self.buf[at..at + N]);
        Ok(out)
    }

    fn u32(&mut self) -> Result<u32, Stop> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }

    fn u64(&mut self) -> Result<u64, Stop> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }

    fn string(&mut self) -> Result<String, Stop> {
        let len = self.u64()? as f64;
        // A sane key or value is never a gigabyte; treat that as corrupt.
        if len > MAX_SAFE || len > 64.0 * 1024.0 * 1024.0 {
            return Err(Stop::Bad);
        }
        let start = self.need(len)?;
        // `Buffer.toString("utf8")`: malformed sequences replaced, a BOM kept.
        Ok(String::from_utf8_lossy(&self.buf[start..start + len as usize]).into_owned())
    }

    /// One metadata value; `None` for arrays, which are skipped whole.
    fn value(&mut self) -> Result<Option<Val>, Stop> {
        let tag = self.u32()?;
        self.typed(tag)
    }

    fn typed(&mut self, tag: u32) -> Result<Option<Val>, Stop> {
        let n = |x: f64| Ok(Some(Val::Num(x)));
        match tag {
            0 | 7 => n(self.bytes::<1>()?[0] as f64),
            1 => n(i8::from_le_bytes(self.bytes()?) as f64),
            2 => n(u16::from_le_bytes(self.bytes()?) as f64),
            3 => n(i16::from_le_bytes(self.bytes()?) as f64),
            4 => n(u32::from_le_bytes(self.bytes()?) as f64),
            5 => n(i32::from_le_bytes(self.bytes()?) as f64),
            6 => n(f32::from_le_bytes(self.bytes()?) as f64),
            8 => Ok(Some(Val::Str(self.string()?))),
            10 => n(u64::from_le_bytes(self.bytes()?) as f64),
            11 => n(i64::from_le_bytes(self.bytes()?) as f64),
            12 => n(f64::from_le_bytes(self.bytes()?)),
            9 => {
                self.skip_array()?;
                Ok(None)
            }
            // An unknown type means the next pair's start is lost.
            _ => Err(Stop::Bad),
        }
    }

    fn skip_array(&mut self) -> Result<(), Stop> {
        let elem = self.u32()?;
        let count = self.u64()? as f64;
        if count > MAX_SAFE {
            return Err(Stop::Bad);
        }
        let fixed = match elem {
            0 | 1 | 7 => Some(1.0),
            2 | 3 => Some(2.0),
            4..=6 => Some(4.0),
            10..=12 => Some(8.0),
            _ => None,
        };
        if let Some(width) = fixed {
            self.need(width * count)?;
            return Ok(());
        }
        if elem == 8 {
            for _ in 0..count as u64 {
                self.string()?;
            }
            return Ok(());
        }
        Err(Stop::Bad)
    }
}
