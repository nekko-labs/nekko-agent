//! Registering a FIDO2 credential (SK-4): the computer's side of
//! `navigator.credentials.create()`, so the step-up verifier (`step_up.rs`)
//! has a public key to check assertions against.
//!
//! The computer asks for no attestation (`attestation: "none"`): it does not
//! care which company made the key, only that the same key answers later, so
//! the attestation statement is never checked, whatever its format. What is
//! checked:
//!
//! - `clientDataJSON`: `type` is `webauthn.create`, its challenge one this
//!   computer issued for a registration (live, unused; any answer spends it),
//!   and its origin one the caller accepts for this relying party;
//! - the authenticator data inside the CBOR attestation object: rpIdHash is
//!   SHA-256 of the relying-party id the page used, user presence is set,
//!   attested credential data is present, and its credential id is the one
//!   the page reported;
//! - the credential public key (COSE): EC2 (`kty` 2), ES256 (`alg` -7), P-256
//!   (`crv` 1), a point on the curve. Any other algorithm is refused: the
//!   verifiers check ES256 only.
//!
//! No CBOR crate: the decoder below reads the definite-length subset WebAuthn
//! uses (integers, byte and text strings, arrays, maps, simple values) and
//! refuses the rest.

use crate::step_up::{Issued, from_b64url};
use p256::ecdsa::VerifyingKey;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// WebAuthn's registration type in `clientDataJSON`.
pub const CREATE_TYPE: &str = "webauthn.create";

/// COSE: key type EC2, algorithm ES256, curve P-256.
const COSE_KTY_EC2: i64 = 2;
const COSE_ALG_ES256: i64 = -7;
const COSE_CRV_P256: i64 = 1;

/// Authenticator data flags.
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;

/// A CBOR value, as far as WebAuthn needs one.
#[derive(Debug, Clone, PartialEq)]
pub enum Cbor {
    Int(i128),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
    Bool(bool),
    Null,
}

impl Cbor {
    fn get_int(&self, key: i128) -> Option<&Cbor> {
        let Cbor::Map(m) = self else { return None };
        m.iter().find(|(k, _)| *k == Cbor::Int(key)).map(|(_, v)| v)
    }

    fn get_text(&self, key: &str) -> Option<&Cbor> {
        let Cbor::Map(m) = self else { return None };
        m.iter().find(|(k, _)| matches!(k, Cbor::Text(t) if t == key)).map(|(_, v)| v)
    }

    fn int(&self) -> Option<i128> {
        if let Cbor::Int(n) = self { Some(*n) } else { None }
    }

    fn bytes(&self) -> Option<&[u8]> {
        if let Cbor::Bytes(b) = self { Some(b) } else { None }
    }
}

/// Deep enough for any attestation object; a deeper one is not WebAuthn's.
const MAX_DEPTH: usize = 16;

/// Decode one CBOR item at `*pos`, moving `pos` past it.
pub fn decode(buf: &[u8], pos: &mut usize) -> Option<Cbor> {
    decode_at(buf, pos, 0)
}

fn decode_at(buf: &[u8], pos: &mut usize, depth: usize) -> Option<Cbor> {
    if depth > MAX_DEPTH {
        return None;
    }
    let first = *buf.get(*pos)?;
    *pos += 1;
    let (major, info) = (first >> 5, first & 0x1f);
    let mut take = |n: usize| -> Option<u64> {
        let bytes = buf.get(*pos..pos.checked_add(n)?)?;
        *pos += n;
        Some(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
    };
    let arg = match info {
        0..=23 => u64::from(info),
        24 => take(1)?,
        25 => take(2)?,
        26 => take(4)?,
        27 => take(8)?,
        // Indefinite lengths and reserved values: never in WebAuthn's output.
        _ => return None,
    };
    let len = |n: u64| usize::try_from(n).ok().filter(|n| *n <= buf.len());
    match major {
        0 => Some(Cbor::Int(i128::from(arg))),
        1 => Some(Cbor::Int(-1 - i128::from(arg))),
        2 | 3 => {
            let n = len(arg)?;
            let bytes = buf.get(*pos..pos.checked_add(n)?)?.to_vec();
            *pos += n;
            if major == 2 { Some(Cbor::Bytes(bytes)) } else { String::from_utf8(bytes).ok().map(Cbor::Text) }
        }
        4 => {
            let n = len(arg)?;
            let mut items = Vec::with_capacity(n.min(64));
            for _ in 0..n {
                items.push(decode_at(buf, pos, depth + 1)?);
            }
            Some(Cbor::Array(items))
        }
        5 => {
            let n = len(arg)?;
            let mut items = Vec::with_capacity(n.min(64));
            for _ in 0..n {
                let k = decode_at(buf, pos, depth + 1)?;
                let v = decode_at(buf, pos, depth + 1)?;
                items.push((k, v));
            }
            Some(Cbor::Map(items))
        }
        // A tag: the tagged item stands for itself.
        6 => decode_at(buf, pos, depth + 1),
        7 => match info {
            20 => Some(Cbor::Bool(false)),
            21 => Some(Cbor::Bool(true)),
            22 | 23 => Some(Cbor::Null),
            _ => None,
        },
        _ => None,
    }
}

/// A COSE ES256 public key as the 65-byte X9.63 uncompressed point the
/// verifiers read (`SecurityCredential.publicKey`), or why not.
pub fn cose_es256_point(key: &Cbor) -> Result<Vec<u8>, &'static str> {
    if key.get_int(1).and_then(Cbor::int) != Some(i128::from(COSE_KTY_EC2)) {
        return Err("key type");
    }
    if key.get_int(3).and_then(Cbor::int) != Some(i128::from(COSE_ALG_ES256)) {
        return Err("algorithm");
    }
    if key.get_int(-1).and_then(Cbor::int) != Some(i128::from(COSE_CRV_P256)) {
        return Err("curve");
    }
    let (Some(x), Some(y)) = (key.get_int(-2).and_then(Cbor::bytes), key.get_int(-3).and_then(Cbor::bytes)) else {
        return Err("key");
    };
    if x.len() != 32 || y.len() != 32 {
        return Err("key");
    }
    let mut point = Vec::with_capacity(65);
    point.push(4);
    point.extend_from_slice(x);
    point.extend_from_slice(y);
    VerifyingKey::from_sec1_bytes(&point).map_err(|_| "key")?;
    Ok(point)
}

/// What the authenticator data of a registration says.
#[derive(Debug, Clone, PartialEq)]
pub struct AttestedData {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub counter: u32,
    pub credential_id: Vec<u8>,
    /// X9.63 uncompressed P-256 point.
    pub public_key: Vec<u8>,
}

/// Parse authenticator data carrying attested credential data.
pub fn attested_data(auth: &[u8]) -> Result<AttestedData, &'static str> {
    if auth.len() < 37 + 18 {
        return Err("authenticatorData");
    }
    let mut rp_id_hash = [0u8; 32];
    rp_id_hash.copy_from_slice(&auth[..32]);
    let flags = auth[32];
    let counter = u32::from_be_bytes([auth[33], auth[34], auth[35], auth[36]]);
    if flags & FLAG_AT == 0 {
        return Err("no credential");
    }
    // aaguid (16), then the credential id's length (2).
    let id_len = usize::from(u16::from_be_bytes([auth[53], auth[54]]));
    let id_end = 55 + id_len;
    let credential_id = auth.get(55..id_end).ok_or("authenticatorData")?.to_vec();
    if credential_id.is_empty() {
        return Err("credential");
    }
    let mut pos = id_end;
    let key = decode(auth, &mut pos).ok_or("key")?;
    let public_key = cose_es256_point(&key)?;
    Ok(AttestedData { rp_id_hash, flags, counter, credential_id, public_key })
}

/// A registration the computer accepted.
#[derive(Debug, Clone, PartialEq)]
pub struct Registered {
    /// Unpadded base64url, as `SecurityCredential.id`.
    pub id: String,
    /// X9.63 point, unpadded base64url (the verifiers read either base64 form).
    pub public_key: String,
    pub counter: u32,
    /// Whether the authenticator verified the user (PIN, biometrics) at registration.
    pub uv: bool,
    pub origin: String,
}

/// What the page sent back from `navigator.credentials.create()`, every
/// binary field unpadded base64url.
#[derive(Debug, Clone, Default)]
pub struct Answer<'a> {
    pub id: &'a str,
    pub client_data_json: &'a str,
    pub attestation_object: &'a str,
}

/// The host part of an origin (`https://a.example:8443` → `a.example`).
pub fn origin_host(origin: &str) -> Option<&str> {
    let rest = origin.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = if host.starts_with('[') { host.split(']').next().map(|h| &h[1..])? } else { host.split(':').next()? };
    (!host.is_empty()).then_some(host)
}

/// Whether a page at `origin` may use `rp_id` (WebAuthn's rule: the host is
/// the relying-party id or a subdomain of it), over https, or over http to
/// `localhost` (a secure context).
pub fn origin_fits_rp_id(origin: &str, rp_id: &str) -> bool {
    let Some(host) = origin_host(origin) else { return false };
    let host = host.to_ascii_lowercase();
    let rp = rp_id.to_ascii_lowercase();
    let fits = host == rp || host.ends_with(&format!(".{rp}"));
    let secure = origin.starts_with("https://") || (origin.starts_with("http://") && host == "localhost");
    fits && secure && !rp.is_empty()
}

/// Check a registration against the challenges issued for one and the
/// relying-party id the page used. `issued` is updated in place (the answered
/// challenge is spent whatever the outcome). The error is a few words, for
/// the owner's message and the logs.
pub fn verify(
    issued: &mut [Issued],
    now: f64,
    ttl_ms: f64,
    rp_id: &str,
    answer: &Answer<'_>,
) -> Result<Registered, &'static str> {
    let (Some(id), Some(cdj), Some(att)) =
        (from_b64url(answer.id), from_b64url(answer.client_data_json), from_b64url(answer.attestation_object))
    else {
        return Err("encoding");
    };
    let client: Value =
        std::str::from_utf8(&cdj).ok().and_then(|s| serde_json::from_str(s).ok()).ok_or("clientData")?;
    if client.get("type").and_then(Value::as_str) != Some(CREATE_TYPE) {
        return Err("clientData");
    }
    let said = client.get("challenge").and_then(Value::as_str).and_then(from_b64url).ok_or("clientData")?;
    let entry =
        issued.iter_mut().find(|x| from_b64url(&x.challenge).as_deref() == Some(&said[..])).ok_or("challenge")?;
    if entry.used {
        return Err("replayed");
    }
    entry.used = true;
    if now - entry.issued_at > ttl_ms {
        return Err("stale");
    }
    let origin = client.get("origin").and_then(Value::as_str).ok_or("origin")?.to_string();
    if !origin_fits_rp_id(&origin, rp_id) {
        return Err("origin");
    }
    let mut pos = 0;
    let object = decode(&att, &mut pos).ok_or("attestationObject")?;
    if !matches!(object.get_text("fmt"), Some(Cbor::Text(_))) {
        return Err("attestationObject");
    }
    let auth = object.get_text("authData").and_then(Cbor::bytes).ok_or("attestationObject")?;
    let data = attested_data(auth)?;
    if data.rp_id_hash[..] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err("rpId");
    }
    if data.flags & FLAG_UP == 0 {
        return Err("user presence");
    }
    if data.credential_id != id {
        return Err("credential");
    }
    Ok(Registered {
        id: crate::step_up::to_b64url(&data.credential_id),
        public_key: crate::step_up::to_b64url(&data.public_key),
        counter: data.counter,
        uv: data.flags & FLAG_UV != 0,
        origin,
    })
}

/// Encode a CBOR value (definite lengths): for building attestation objects in tests.
pub fn encode(v: &Cbor) -> Vec<u8> {
    fn head(out: &mut Vec<u8>, major: u8, n: u64) {
        let m = major << 5;
        match n {
            0..=23 => out.push(m | n as u8),
            24..=0xff => out.extend([m | 24, n as u8]),
            0x100..=0xffff => {
                out.push(m | 25);
                out.extend((n as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                out.push(m | 26);
                out.extend((n as u32).to_be_bytes());
            }
            _ => {
                out.push(m | 27);
                out.extend(n.to_be_bytes());
            }
        }
    }
    let mut out = Vec::new();
    match v {
        Cbor::Int(n) if *n >= 0 => head(&mut out, 0, *n as u64),
        Cbor::Int(n) => head(&mut out, 1, (-1 - *n) as u64),
        Cbor::Bytes(b) => {
            head(&mut out, 2, b.len() as u64);
            out.extend(b);
        }
        Cbor::Text(t) => {
            head(&mut out, 3, t.len() as u64);
            out.extend(t.as_bytes());
        }
        Cbor::Array(a) => {
            head(&mut out, 4, a.len() as u64);
            a.iter().for_each(|x| out.extend(encode(x)));
        }
        Cbor::Map(m) => {
            head(&mut out, 5, m.len() as u64);
            for (k, x) in m {
                out.extend(encode(k));
                out.extend(encode(x));
            }
        }
        Cbor::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
        Cbor::Null => out.push(0xf6),
    }
    out
}

/// A COSE ES256 public key from its two coordinates.
pub fn cose_es256_key(x: &[u8], y: &[u8]) -> Cbor {
    Cbor::Map(vec![
        (Cbor::Int(1), Cbor::Int(i128::from(COSE_KTY_EC2))),
        (Cbor::Int(3), Cbor::Int(i128::from(COSE_ALG_ES256))),
        (Cbor::Int(-1), Cbor::Int(i128::from(COSE_CRV_P256))),
        (Cbor::Int(-2), Cbor::Bytes(x.to_vec())),
        (Cbor::Int(-3), Cbor::Bytes(y.to_vec())),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::step_up::to_b64url;
    use p256::ecdsa::SigningKey;
    use serde_json::json;

    fn cose(key: &SigningKey, alg: i128) -> Cbor {
        let point = key.verifying_key().to_encoded_point(false);
        Cbor::Map(vec![
            (Cbor::Int(1), Cbor::Int(2)),
            (Cbor::Int(3), Cbor::Int(alg)),
            (Cbor::Int(-1), Cbor::Int(1)),
            (Cbor::Int(-2), Cbor::Bytes(point.x().unwrap().to_vec())),
            (Cbor::Int(-3), Cbor::Bytes(point.y().unwrap().to_vec())),
        ])
    }

    struct Make<'a> {
        key: &'a SigningKey,
        rp_id: &'a str,
        challenge: &'a str,
        origin: &'a str,
        id: &'a [u8],
        flags: u8,
        kind: &'a str,
        alg: i128,
        fmt: &'a str,
    }

    impl<'a> Make<'a> {
        fn new(key: &'a SigningKey, challenge: &'a str) -> Self {
            Self {
                key,
                rp_id: "localhost",
                challenge,
                origin: "http://localhost:5173",
                id: &[7; 16],
                flags: FLAG_UP | FLAG_UV | FLAG_AT,
                kind: CREATE_TYPE,
                alg: -7,
                fmt: "none",
            }
        }

        /// `(id, clientDataJSON, attestationObject)`, base64url.
        fn build(&self) -> (String, String, String) {
            let mut auth = Sha256::digest(self.rp_id.as_bytes()).to_vec();
            auth.push(self.flags);
            auth.extend(0u32.to_be_bytes());
            auth.extend([0u8; 16]);
            auth.extend((self.id.len() as u16).to_be_bytes());
            auth.extend(self.id);
            auth.extend(encode(&cose(self.key, self.alg)));
            let object = Cbor::Map(vec![
                (Cbor::Text("fmt".into()), Cbor::Text(self.fmt.into())),
                (Cbor::Text("attStmt".into()), Cbor::Map(vec![])),
                (Cbor::Text("authData".into()), Cbor::Bytes(auth)),
            ]);
            let cdj =
                json!({ "type": self.kind, "challenge": self.challenge, "origin": self.origin, "crossOrigin": false });
            (to_b64url(self.id), to_b64url(cdj.to_string().as_bytes()), to_b64url(&encode(&object)))
        }
    }

    const C: &str = "BwcHBwcHBwcHBwcHBwcHBwcH";
    const NOW: f64 = 1_790_000_000_000.0;

    fn live() -> Vec<Issued> {
        vec![Issued { challenge: C.into(), issued_at: NOW - 1000.0, used: false }]
    }

    fn run(m: &Make<'_>, issued: &mut [Issued]) -> Result<Registered, &'static str> {
        let (id, cdj, att) = m.build();
        verify(
            issued,
            NOW,
            120_000.0,
            "localhost",
            &Answer { id: &id, client_data_json: &cdj, attestation_object: &att },
        )
    }

    fn key() -> SigningKey {
        SigningKey::from_slice(&[11; 32]).unwrap()
    }

    #[test]
    fn accepts_a_none_attestation_and_returns_the_x963_point() {
        let k = key();
        let mut book = live();
        let r = run(&Make::new(&k, C), &mut book).unwrap();
        assert_eq!(r.id, to_b64url(&[7; 16]));
        let point = from_b64url(&r.public_key).unwrap();
        assert_eq!(point, k.verifying_key().to_encoded_point(false).as_bytes());
        assert!(r.uv);
        assert_eq!(r.origin, "http://localhost:5173");
        assert!(book[0].used, "the challenge is spent");
    }

    #[test]
    fn ignores_the_attestation_statement_whatever_its_format() {
        let k = key();
        assert!(run(&Make { fmt: "packed", ..Make::new(&k, C) }, &mut live()).is_ok());
    }

    #[test]
    fn refuses_what_is_not_a_fresh_registration_for_this_relying_party() {
        let k = key();
        let base = || Make::new(&k, C);
        assert_eq!(run(&Make { kind: "webauthn.get", ..base() }, &mut live()), Err("clientData"));
        assert_eq!(run(&Make { challenge: "CQkJCQkJCQkJCQkJCQkJCQkJ", ..base() }, &mut live()), Err("challenge"));
        let mut spent = vec![Issued { used: true, ..live()[0].clone() }];
        assert_eq!(run(&base(), &mut spent), Err("replayed"));
        let mut old = vec![Issued { issued_at: NOW - 120_001.0, ..live()[0].clone() }];
        assert_eq!(run(&base(), &mut old), Err("stale"));
        assert!(old[0].used, "a late answer spends it too");
        assert_eq!(run(&Make { origin: "https://evil.example", ..base() }, &mut live()), Err("origin"));
        assert_eq!(run(&Make { origin: "http://127.0.0.1:5173", ..base() }, &mut live()), Err("origin"));
        assert_eq!(run(&Make { rp_id: "evil.example", ..base() }, &mut live()), Err("rpId"));
        assert_eq!(run(&Make { flags: FLAG_UV | FLAG_AT, ..base() }, &mut live()), Err("user presence"));
        assert_eq!(run(&Make { flags: FLAG_UP, ..base() }, &mut live()), Err("no credential"));
        assert_eq!(run(&Make { alg: -8, ..base() }, &mut live()), Err("algorithm"));
    }

    #[test]
    fn refuses_a_credential_id_other_than_the_one_reported() {
        let k = key();
        let (_, cdj, att) = Make::new(&k, C).build();
        let other = to_b64url(&[8; 16]);
        let a = Answer { id: &other, client_data_json: &cdj, attestation_object: &att };
        assert_eq!(verify(&mut live(), NOW, 120_000.0, "localhost", &a), Err("credential"));
    }

    #[test]
    fn refuses_a_point_off_the_curve() {
        let bad = Cbor::Map(vec![
            (Cbor::Int(1), Cbor::Int(2)),
            (Cbor::Int(3), Cbor::Int(-7)),
            (Cbor::Int(-1), Cbor::Int(1)),
            (Cbor::Int(-2), Cbor::Bytes(vec![1; 32])),
            (Cbor::Int(-3), Cbor::Bytes(vec![2; 32])),
        ]);
        assert_eq!(cose_es256_point(&bad), Err("key"));
    }

    #[test]
    fn decodes_the_webauthn_subset_and_refuses_the_rest() {
        let v = Cbor::Map(vec![
            (Cbor::Int(-300), Cbor::Array(vec![Cbor::Bool(true), Cbor::Null, Cbor::Int(70_000)])),
            (Cbor::Text("t".into()), Cbor::Bytes(vec![0; 300])),
        ]);
        let bytes = encode(&v);
        let mut pos = 0;
        assert_eq!(decode(&bytes, &mut pos), Some(v));
        assert_eq!(pos, bytes.len());
        // Indefinite length, a truncated string, a length past the end, too deep.
        for bad in
            [vec![0x9f, 0x01, 0xff], vec![0x43, 1, 2], vec![0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]]
        {
            assert_eq!(decode(&bad, &mut 0), None, "{bad:?}");
        }
        assert_eq!(decode(&[0x81; 40], &mut 0), None);
        assert_eq!(decode(&[0x62, 0xff, 0xfe], &mut 0), None, "text must be UTF-8");
    }

    #[test]
    fn origins_fit_the_relying_party_id_as_webauthn_says() {
        assert!(origin_fits_rp_id("http://localhost:49152", "localhost"));
        assert!(origin_fits_rp_id("https://agent.example.com", "example.com"));
        assert!(origin_fits_rp_id("https://example.com:8443", "example.com"));
        assert!(!origin_fits_rp_id("http://agent.example.com", "example.com"), "plain http off localhost");
        assert!(!origin_fits_rp_id("https://badexample.com", "example.com"));
        assert!(!origin_fits_rp_id("https://example.com", ""));
        assert_eq!(origin_host("https://[::1]:8443/x"), Some("::1"));
    }
}
