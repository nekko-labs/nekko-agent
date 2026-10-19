//! "Visible on this network" (TASKS.md PH2): the desktop answers mDNS /
//! DNS-SD for `_nekko-agent._tcp.local`, so a phone on the same Wi-Fi can list
//! this computer by name instead of the user hunting for its QR code.
//!
//! A port of `apps/desktop/src/backend/network-visibility.ts`. Off by default.
//! What it says is readable by anyone on the network, so the TXT record
//! carries only the computer's name, the relay address phones would dial
//! (when this computer runs its own relay, else nothing), and a version.
//! Never the room, the key or a pairing code.
//!
//! A small responder on plain UDP multicast: it answers questions about its
//! own records, announces on start and on changes, and says goodbye (TTL 0)
//! on stop. The labels, records and wire format are golden-tested against
//! the TS (`desktop-features.golden.test.ts`).

use serde::Serialize;
use serde_json::{Value, json};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UdpSocket;

pub const SERVICE_TYPE: &str = "_nekko-agent._tcp.local";
const SERVICES_ENUM: &str = "_services._dns-sd._udp.local";
const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;

pub const TYPE_A: u16 = 1;
pub const TYPE_PTR: u16 = 12;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_SRV: u16 = 33;
pub const TYPE_ANY: u16 = 255;
const CLASS_IN: u16 = 1;
const CACHE_FLUSH: u16 = 0x8000;
/// RFC 6762 §10: host records 120 s, the rest 75 minutes.
const TTL_HOST: u32 = 120;
const TTL_OTHER: u32 = 4500;
/// How often to notice a new LAN address or relay and re-announce.
const WATCH: Duration = Duration::from_secs(30);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Data {
    Text(String),
    Strings(Vec<String>),
    Srv { port: u16, target: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Record {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u16,
    pub ttl: u32,
    /// Unique records (SRV, TXT, A) set the cache-flush bit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    pub data: Data,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Question {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u16,
    /// The QU bit: the asker wants a unicast reply.
    pub unicast: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Packet {
    pub id: u16,
    pub response: bool,
    pub questions: Vec<Question>,
    pub answers: Vec<Record>,
}

// ------------------------------------------------------------------ wire format
//
// RFC 1035 §4, RFC 6762. Names are written uncompressed; reads follow
// compression pointers, with a hop limit so a looping packet can't hang.

fn encode_name(name: &str, out: &mut Vec<u8>) {
    let name = name.strip_suffix('.').unwrap_or(name);
    for part in name.split('.').filter(|p| !p.is_empty()) {
        let label = &part.as_bytes()[..part.len().min(63)];
        out.push(label.len() as u8);
        out.extend_from_slice(label);
    }
    out.push(0);
}

/// `Number(part)` as `Buffer.from([...])` stores it: a byte, NaN as 0.
fn js_byte(part: &str) -> u8 {
    let n = nekko_js::to_number(Some(&Value::String(part.to_string())));
    if n.is_finite() { (n.trunc() as i64).rem_euclid(256) as u8 } else { 0 }
}

fn encode_data(r: &Record) -> Vec<u8> {
    let mut out = Vec::new();
    match (r.kind, &r.data) {
        (TYPE_A, data) => {
            let text = match data {
                Data::Text(t) => t.clone(),
                Data::Strings(s) => s.join(","),
                Data::Srv { .. } => "[object Object]".into(),
            };
            out.extend(text.split('.').map(js_byte));
        }
        (TYPE_PTR, Data::Text(t)) => encode_name(t, &mut out),
        (TYPE_TXT, Data::Strings(entries)) => {
            for s in entries {
                let b = &s.as_bytes()[..s.len().min(255)];
                out.push(b.len() as u8);
                out.extend_from_slice(b);
            }
            if entries.is_empty() {
                out.push(0);
            }
        }
        (TYPE_SRV, Data::Srv { port, target }) => {
            out.extend_from_slice(&[0, 0, 0, 0]); // priority, weight
            out.extend_from_slice(&port.to_be_bytes());
            encode_name(target, &mut out);
        }
        _ => {}
    }
    out
}

pub fn encode_packet(p: &Packet) -> Vec<u8> {
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(&p.id.to_be_bytes());
    // Responses: QR + AA. mDNS queries carry no flags.
    out.extend_from_slice(&(if p.response { 0x8400u16 } else { 0 }).to_be_bytes());
    out.extend_from_slice(&(p.questions.len() as u16).to_be_bytes());
    out.extend_from_slice(&(p.answers.len() as u16).to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    for q in &p.questions {
        encode_name(&q.name, &mut out);
        out.extend_from_slice(&q.kind.to_be_bytes());
        out.extend_from_slice(&(CLASS_IN | if q.unicast { 0x8000 } else { 0 }).to_be_bytes());
    }
    for r in &p.answers {
        let data = encode_data(r);
        encode_name(&r.name, &mut out);
        out.extend_from_slice(&r.kind.to_be_bytes());
        out.extend_from_slice(&(CLASS_IN | if r.unique == Some(true) { CACHE_FLUSH } else { 0 }).to_be_bytes());
        out.extend_from_slice(&r.ttl.to_be_bytes());
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(&data);
    }
    out
}

fn u16_at(buf: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*buf.get(at)?, *buf.get(at + 1)?]))
}

fn u32_at(buf: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*buf.get(at)?, *buf.get(at + 1)?, *buf.get(at + 2)?, *buf.get(at + 3)?]))
}

/// `buf.toString('utf8', start, end)`: the end clamped to the buffer.
fn utf8(buf: &[u8], start: usize, end: usize) -> String {
    let end = end.min(buf.len());
    if start >= end {
        return String::new();
    }
    String::from_utf8_lossy(&buf[start..end]).into_owned()
}

fn read_name(buf: &[u8], start: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut at = start;
    let mut end: Option<usize> = None;
    for _ in 0..32 {
        let len = *buf.get(at)? as usize;
        if len == 0 {
            return Some((labels.join("."), end.unwrap_or(at + 1)));
        }
        if len & 0xc0 == 0xc0 {
            let low = *buf.get(at + 1)? as usize;
            end.get_or_insert(at + 2);
            at = ((len & 0x3f) << 8) | low;
            continue;
        }
        if at + 1 + len > buf.len() {
            return None;
        }
        labels.push(utf8(buf, at + 1, at + 1 + len));
        at += 1 + len;
    }
    None
}

fn decode_data(buf: &[u8], kind: u16, at: usize, len: usize) -> Option<Data> {
    Some(match kind {
        TYPE_A => Data::Text(if len == 4 {
            buf[at..at + 4].iter().map(u8::to_string).collect::<Vec<_>>().join(".")
        } else {
            String::new()
        }),
        TYPE_PTR => Data::Text(read_name(buf, at)?.0),
        TYPE_TXT => {
            let mut out = Vec::new();
            let mut i = at;
            while i < at + len {
                let n = *buf.get(i)? as usize;
                if n > 0 {
                    out.push(utf8(buf, i + 1, i + 1 + n));
                }
                i += 1 + n;
            }
            Data::Strings(out)
        }
        TYPE_SRV => Data::Srv { port: u16_at(buf, at + 4)?, target: read_name(buf, at + 6)?.0 },
        _ => Data::Text(String::new()),
    })
}

/// `None` for anything malformed: the network is not trusted.
pub fn decode_packet(buf: &[u8]) -> Option<Packet> {
    if buf.len() < 12 {
        return None;
    }
    let id = u16_at(buf, 0)?;
    let response = u16_at(buf, 2)? & 0x8000 != 0;
    let qd = u16_at(buf, 4)?;
    let an = u16_at(buf, 6)?;
    let mut at = 12;
    let mut questions = Vec::new();
    for _ in 0..qd {
        let (name, end) = read_name(buf, at)?;
        let kind = u16_at(buf, end)?;
        let class = u16_at(buf, end + 2)?;
        questions.push(Question { name, kind, unicast: class & 0x8000 != 0 });
        at = end + 4;
    }
    let mut answers = Vec::new();
    for _ in 0..an {
        let (name, end) = read_name(buf, at)?;
        let kind = u16_at(buf, end)?;
        let class = u16_at(buf, end + 2)?;
        let ttl = u32_at(buf, end + 4)?;
        let len = u16_at(buf, end + 8)? as usize;
        let data_at = end + 10;
        if data_at + len > buf.len() {
            return None;
        }
        let data = decode_data(buf, kind, data_at, len)?;
        answers.push(Record { name, kind, ttl, unique: Some(class & CACHE_FLUSH != 0), data });
        at = data_at + len;
    }
    Some(Packet { id, response, questions, answers })
}

// ------------------------------------------------------------------ what this computer says

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advertisement {
    /// The instance label phones list, e.g. "Studio".
    pub name: String,
    /// `<host>.local`, the SRV target.
    pub host: String,
    /// This computer's LAN IPv4 addresses.
    pub addresses: Vec<String>,
    /// The relay phones would dial, when this computer runs one (PH4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// SRV port: the local relay's when running, else 0.
    pub port: u16,
}

/// JavaScript's `\s`.
pub fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2028}' | '\u{2029}')
        || ('\u{2000}'..='\u{200a}').contains(&c)
        || matches!(c, '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `/\.local\.?$/i` removed.
fn strip_local(raw: &str) -> &str {
    let s = raw.strip_suffix('.').unwrap_or(raw);
    if s.len() >= 6 && s.is_char_boundary(s.len() - 6) && s[s.len() - 6..].eq_ignore_ascii_case(".local") {
        return &s[..s.len() - 6];
    }
    raw
}

/// A DNS label safe for the instance name: printable, no dots, at most 63
/// bytes. As UTF-8: the TS trims a UTF-16 unit at a time, so an emoji at the
/// cut can leave half a surrogate pair, which goes out as U+FFFD.
pub fn service_label(raw: &str) -> String {
    let replaced: String =
        strip_local(raw).chars().map(|c| if c <= '\u{1f}' || c == '\u{7f}' || c == '.' { ' ' } else { c }).collect();
    let mut clean = String::new();
    let mut space = false;
    for c in replaced.chars() {
        if js_space(c) {
            space = true;
            continue;
        }
        if space && !clean.is_empty() {
            clean.push(' ');
        }
        space = false;
        clean.push(c);
    }
    let mut label = if clean.is_empty() { "Nekko Agent".to_string() } else { clean };
    while label.len() > 63 {
        let last = label.pop().expect("longer than 63 bytes");
        // Half a surrogate pair is three bytes once encoded.
        if last.len_utf16() == 2 && label.len() + 3 <= 63 {
            label.push('\u{fffd}');
        }
    }
    label
}

/// Host labels are stricter than instance labels: letters, digits and hyphens.
pub fn host_label(raw: &str) -> String {
    let first = strip_local(raw).split('.').next().unwrap_or("").to_lowercase();
    let mut out = String::new();
    let mut run = false;
    for c in first.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            out.push(c);
            run = false;
        } else if !run {
            out.push('-');
            run = true;
        }
    }
    let clean: String = out.trim_matches('-').chars().take(63).collect();
    if clean.is_empty() { "nekko-agent".into() } else { clean }
}

/// One address of `os.networkInterfaces()`.
#[derive(Clone, Debug)]
pub struct Nic {
    /// The adapter's name, as the OS gives it ("en0", "Ethernet").
    pub name: String,
    pub address: String,
    pub ipv4: bool,
    pub internal: bool,
}

/// This machine's interfaces, in the order the OS lists them.
pub fn interfaces() -> Vec<Nic> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| Nic {
            name: i.name.clone(),
            address: i.ip().to_string(),
            ipv4: i.ip().is_ipv4(),
            internal: i.is_loopback(),
        })
        .collect()
}

/// LAN IPv4 only: loopback is useless to a phone, and the tailnet has no multicast.
pub fn lan_addresses(nics: &[Nic]) -> Vec<String> {
    nics.iter()
        .filter(|n| n.ipv4 && !n.internal)
        .filter(|n| {
            let mut parts = n.address.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
            let (a, b) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
            !(a == 100 && (64..=127).contains(&b))
        })
        .map(|n| n.address.clone())
        .collect()
}

/// The TXT strings. Nothing that lets anyone into the room.
pub fn txt_record(name: &str, relay_url: Option<&str>) -> Vec<String> {
    let mut txt = vec!["v=1".to_string(), format!("name={name}")];
    if let Some(r) = relay_url.filter(|r| !r.is_empty()) {
        txt.push(format!("relay={r}"));
    }
    txt
}

pub fn records_for(ad: &Advertisement, ttl_scale: u32) -> Vec<Record> {
    let instance = format!("{}.{SERVICE_TYPE}", ad.name);
    let host = format!("{}.local", ad.host);
    let mut out = vec![
        Record {
            name: SERVICE_TYPE.into(),
            kind: TYPE_PTR,
            ttl: TTL_OTHER * ttl_scale,
            unique: None,
            data: Data::Text(instance.clone()),
        },
        Record {
            name: instance.clone(),
            kind: TYPE_SRV,
            ttl: TTL_HOST * ttl_scale,
            unique: Some(true),
            data: Data::Srv { port: ad.port, target: host.clone() },
        },
        Record {
            name: instance,
            kind: TYPE_TXT,
            ttl: TTL_OTHER * ttl_scale,
            unique: Some(true),
            data: Data::Strings(txt_record(&ad.name, ad.relay_url.as_deref())),
        },
    ];
    out.extend(ad.addresses.iter().map(|a| Record {
        name: host.clone(),
        kind: TYPE_A,
        ttl: TTL_HOST * ttl_scale,
        unique: Some(true),
        data: Data::Text(a.clone()),
    }));
    out
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The records that answer `questions`, or none when nothing asked is ours.
pub fn answers_for(ad: &Advertisement, questions: &[Question]) -> Vec<Record> {
    // The TS keeps a Set of record objects: each of ours once, the services
    // enumeration answer once per question that asked for it.
    enum Pick {
        Ours(usize),
        Services,
    }
    let all = records_for(ad, 1);
    let mut out: Vec<Pick> = Vec::new();
    let add = |out: &mut Vec<Pick>, i: usize| {
        if !out.iter().any(|p| matches!(p, Pick::Ours(j) if *j == i)) {
            out.push(Pick::Ours(i));
        }
    };
    for q in questions {
        if same(&q.name, SERVICES_ENUM) && (q.kind == TYPE_PTR || q.kind == TYPE_ANY) {
            out.push(Pick::Services);
            continue;
        }
        for (i, r) in all.iter().enumerate() {
            if same(&r.name, &q.name) && (q.kind == r.kind || q.kind == TYPE_ANY) {
                add(&mut out, i);
            }
        }
    }
    // A PTR answer is only useful with what it points at (RFC 6763 §12).
    if out.iter().any(|p| matches!(p, Pick::Ours(i) if all[*i].kind == TYPE_PTR && all[*i].name == SERVICE_TYPE)) {
        for i in 0..all.len() {
            add(&mut out, i);
        }
    }
    out.into_iter()
        .map(|p| match p {
            Pick::Ours(i) => all[i].clone(),
            Pick::Services => Record {
                name: SERVICES_ENUM.into(),
                kind: TYPE_PTR,
                ttl: TTL_OTHER,
                unique: None,
                data: Data::Text(SERVICE_TYPE.into()),
            },
        })
        .collect()
}

// ------------------------------------------------------------------ the switch, the socket

/// The relay to mention, when this computer runs one (PH4): `(url, port)`.
pub type RelayInfo = Arc<dyn Fn() -> Option<(String, u16)> + Send + Sync>;

fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

fn open_multicast(lan: &[String]) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    // Node's `reuseAddr` is SO_REUSEPORT too on the BSDs, where other
    // responders (mDNSResponder) already hold 5353.
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    socket.set_reuse_port(true)?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT)).into())?;
    socket.set_multicast_ttl_v4(255)?;
    socket.set_multicast_loop_v4(true)?;
    // Join on every LAN interface: the default only joins one.
    let joined = lan
        .iter()
        .filter_map(|a| a.parse::<Ipv4Addr>().ok())
        .filter(|a| socket.join_multicast_v4(&MDNS_GROUP, a).is_ok())
        .count();
    if joined == 0 {
        socket.join_multicast_v4(&MDNS_GROUP, &Ipv4Addr::UNSPECIFIED)?;
    }
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

#[derive(Default)]
struct Live {
    enabled: bool,
    socket: Option<Arc<UdpSocket>>,
    /// Ends the open socket's receive loop, so a closed socket lets go of the port.
    stop: Option<Arc<tokio::sync::Notify>>,
    /// What is announced, numbered so a delayed second announcement can tell it is still current.
    current: Option<(u64, Advertisement)>,
    error: Option<String>,
    watching: bool,
}

pub struct NetworkVisibility {
    state_file: PathBuf,
    relay: RelayInfo,
    live: Mutex<Live>,
    /// One refresh at a time (the TS `opening` promise).
    refreshing: tokio::sync::Mutex<()>,
    generation: std::sync::atomic::AtomicU64,
}

impl NetworkVisibility {
    pub fn new(state_file: PathBuf, relay: RelayInfo) -> Arc<Self> {
        // Never switched on, or a file nobody can read: off.
        let enabled = std::fs::read_to_string(&state_file)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .is_some_and(|v| v.get("enabled") == Some(&Value::Bool(true)));
        Arc::new(Self {
            state_file,
            relay,
            live: Mutex::new(Live { enabled, ..Live::default() }),
            refreshing: tokio::sync::Mutex::new(()),
            generation: Default::default(),
        })
    }

    pub fn resume(self: &Arc<Self>) {
        if lock(&self.live).enabled {
            let me = self.clone();
            tokio::spawn(async move { me.start().await });
        }
    }

    pub fn status(&self) -> Value {
        let live = lock(&self.live);
        let ad = live.socket.as_ref().and(live.current.as_ref()).map(|(_, a)| a);
        let mut out = serde_json::Map::new();
        out.insert("available".into(), json!(true));
        out.insert("enabled".into(), json!(live.enabled));
        out.insert("advertising".into(), json!(ad.is_some()));
        if let Some(ad) = ad {
            out.insert("name".into(), json!(ad.name));
            out.insert("addresses".into(), json!(ad.addresses));
            if let Some(r) = &ad.relay_url {
                out.insert("relayUrl".into(), json!(r));
            }
        }
        if live.socket.is_none()
            && let Some(e) = &live.error
        {
            out.insert("error".into(), json!(e));
        }
        Value::Object(out)
    }

    pub async fn start(self: &Arc<Self>) -> Value {
        let watch = {
            let mut live = lock(&self.live);
            if !live.enabled {
                live.enabled = true;
                self.save(true);
            }
            !std::mem::replace(&mut live.watching, true)
        };
        if watch {
            let me = Arc::downgrade(self);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(WATCH);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let Some(me) = me.upgrade() else { return };
                    if !lock(&me.live).watching {
                        return;
                    }
                    me.refresh().await;
                }
            });
        }
        self.refresh().await;
        self.status()
    }

    pub async fn stop(self: &Arc<Self>) -> Value {
        {
            let mut live = lock(&self.live);
            live.enabled = false;
        }
        self.save(false);
        self.close();
        lock(&self.live).error = None;
        self.status()
    }

    /// App shutdown: say goodbye, keep the switch as it is.
    pub fn close(&self) {
        let (socket, current) = {
            let mut live = lock(&self.live);
            live.watching = false;
            if let Some(stop) = live.stop.take() {
                stop.notify_one();
            }
            (live.socket.take(), live.current.take())
        };
        if let (Some(socket), Some((_, ad))) = (socket, current) {
            send(&socket, records_for(&ad, 0));
        }
    }

    fn advertisement(&self) -> Advertisement {
        let raw = hostname();
        let relay = (self.relay)();
        let relay_url = relay.as_ref().map(|(u, _)| u.clone()).filter(|u| !u.is_empty());
        Advertisement {
            name: service_label(&raw),
            host: host_label(&raw),
            addresses: lan_addresses(&interfaces()),
            port: if relay_url.is_some() { relay.map_or(0, |(_, p)| p) } else { 0 },
            relay_url,
        }
    }

    /// Open the socket if needed and (re-)announce when what we say has changed.
    async fn refresh(self: &Arc<Self>) {
        let _one = self.refreshing.lock().await;
        if !lock(&self.live).enabled {
            return;
        }
        let next = self.advertisement();
        if next.addresses.is_empty() {
            let mut live = lock(&self.live);
            live.error =
                Some("This computer isn’t on a local network right now. It becomes visible when it joins one.".into());
            if let (Some(socket), Some((_, ad))) = (&live.socket, &live.current) {
                send(socket, records_for(ad, 0));
            }
            live.current = None;
            return;
        }
        if lock(&self.live).socket.is_none() {
            let lan = next.addresses.clone();
            match tokio::task::spawn_blocking(move || open_multicast(&lan)).await {
                Ok(Ok(socket)) => {
                    let socket = Arc::new(socket);
                    let mut live = lock(&self.live);
                    if !live.enabled {
                        return;
                    }
                    let stop = Arc::new(tokio::sync::Notify::new());
                    live.socket = Some(socket.clone());
                    live.stop = Some(stop.clone());
                    live.error = None;
                    drop(live);
                    self.listen(socket, stop);
                }
                Ok(Err(e)) => {
                    lock(&self.live).error =
                        Some(format!("Couldn’t open the local network port (UDP {MDNS_PORT}): {e}"));
                    return;
                }
                Err(e) => {
                    lock(&self.live).error =
                        Some(format!("Couldn’t open the local network port (UDP {MDNS_PORT}): {e}"));
                    return;
                }
            }
        }
        let announce = {
            let mut live = lock(&self.live);
            let Some(socket) = live.socket.clone() else { return };
            let changed = live.current.as_ref().map(|(_, a)| a) != Some(&next);
            if let Some((_, cur)) = &live.current
                && changed
                && (cur.name != next.name || cur.host != next.host)
            {
                send(&socket, records_for(cur, 0));
            }
            if changed {
                let g = self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                live.current = Some((g, next));
                Some((socket, g))
            } else {
                None
            }
        };
        if let Some((socket, g)) = announce {
            self.announce(socket, g);
        }
    }

    /// RFC 6762 §8.3: at least two unsolicited responses, a second apart.
    fn announce(self: &Arc<Self>, socket: Arc<UdpSocket>, g: u64) {
        let Some(ad) = self.current_if(&socket, g) else { return };
        send(&socket, records_for(&ad, 1));
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if let Some(me) = me.upgrade()
                && let Some(ad) = me.current_if(&socket, g)
            {
                send(&socket, records_for(&ad, 1));
            }
        });
    }

    fn current_if(&self, socket: &Arc<UdpSocket>, g: u64) -> Option<Advertisement> {
        let live = lock(&self.live);
        let same_socket = live.socket.as_ref().is_some_and(|s| Arc::ptr_eq(s, socket));
        live.current.as_ref().filter(|(cg, _)| same_socket && *cg == g).map(|(_, a)| a.clone())
    }

    fn listen(self: &Arc<Self>, socket: Arc<UdpSocket>, stop: Arc<tokio::sync::Notify>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut buf = vec![0u8; 9000];
            loop {
                let got = tokio::select! {
                    got = socket.recv_from(&mut buf) => got,
                    _ = stop.notified() => return,
                };
                let Some(me) = me.upgrade() else { return };
                if !lock(&me.live).socket.as_ref().is_some_and(|s| Arc::ptr_eq(s, &socket)) {
                    return;
                }
                match got {
                    Ok((n, from)) => me.answer(&socket, &buf[..n], from),
                    // Windows reports an ICMP "port unreachable" from an earlier send this way.
                    Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
                    Err(_) => {
                        let mut live = lock(&me.live);
                        live.socket = None;
                        live.stop = None;
                        live.error = Some(
                            "Advertising stopped after a network error. It retries on its own while this is on.".into(),
                        );
                        return;
                    }
                }
            }
        });
    }

    fn answer(&self, socket: &UdpSocket, msg: &[u8], from: SocketAddr) {
        let Some(ad) = lock(&self.live).current.as_ref().map(|(_, a)| a.clone()) else { return };
        let Some(packet) = decode_packet(msg) else { return };
        if packet.response || packet.questions.is_empty() {
            return;
        }
        let answers = answers_for(&ad, &packet.questions);
        if answers.is_empty() {
            return;
        }
        if from.port() != MDNS_PORT {
            // Legacy unicast (RFC 6762 §6.7): reply to the asker, echo id and questions, short TTLs.
            let short = answers.into_iter().map(|r| Record { ttl: r.ttl.min(10), unique: Some(false), ..r }).collect();
            let reply = Packet { id: packet.id, response: true, questions: packet.questions, answers: short };
            let _ = socket.try_send_to(&encode_packet(&reply), from);
            return;
        }
        let reply = encode_packet(&Packet { response: true, answers, ..Packet::default() });
        if packet.questions.iter().all(|q| q.unicast) {
            let _ = socket.try_send_to(&reply, from);
            return;
        }
        let _ = socket.try_send_to(&reply, SocketAddr::V4(SocketAddrV4::new(MDNS_GROUP, MDNS_PORT)));
    }

    fn save(&self, enabled: bool) {
        // Still works this session; it just won't come back by itself.
        if let Some(dir) = self.state_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.state_file, json!({ "enabled": enabled }).to_string());
    }
}

fn send(socket: &UdpSocket, answers: Vec<Record>) {
    // A send can fail while an interface goes away; the next refresh retries.
    let packet = encode_packet(&Packet { response: true, answers, ..Packet::default() });
    let _ = socket.try_send_to(&packet, SocketAddr::V4(SocketAddrV4::new(MDNS_GROUP, MDNS_PORT)));
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn golden() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/desktop-features.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn ad_of(v: &Value) -> Advertisement {
        Advertisement {
            name: v["name"].as_str().unwrap().into(),
            host: v["host"].as_str().unwrap().into(),
            addresses: v["addresses"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().into()).collect(),
            relay_url: v["relayUrl"].as_str().map(str::to_string),
            port: v["port"].as_u64().unwrap() as u16,
        }
    }

    fn question_of(v: &Value) -> Question {
        Question {
            name: v["name"].as_str().unwrap().into(),
            kind: v["type"].as_u64().unwrap() as u16,
            unicast: v["unicast"].as_bool().unwrap(),
        }
    }

    pub fn nics_of(spec: &Value) -> Vec<Nic> {
        let mut out = Vec::new();
        for (name, list) in spec.as_object().unwrap() {
            for n in list.as_array().unwrap() {
                out.push(Nic {
                    name: name.clone(),
                    address: n[0].as_str().unwrap().into(),
                    internal: n[1].as_bool().unwrap(),
                    ipv4: n.get(2).and_then(Value::as_str).unwrap_or("IPv4") == "IPv4",
                });
            }
        }
        out
    }

    #[test]
    fn labels_match_the_ts() {
        for case in golden()["mdns"]["labels"].as_array().unwrap() {
            let raw = case["raw"].as_str().unwrap();
            assert_eq!(hex(service_label(raw).as_bytes()), case["service"].as_str().unwrap(), "service {raw:?}");
            assert_eq!(host_label(raw), case["host"].as_str().unwrap(), "host {raw:?}");
        }
    }

    #[test]
    fn records_and_packets_match_the_ts() {
        let g = golden();
        let m = &g["mdns"];
        let ads: Vec<Advertisement> = m["records"].as_array().unwrap().iter().map(|r| ad_of(&r["ad"])).collect();
        for (i, ad) in ads.iter().enumerate() {
            assert_eq!(json!(txt_record(&ad.name, ad.relay_url.as_deref())), m["txt"][i]);
            let case = &m["records"][i];
            assert_eq!(serde_json::to_value(records_for(ad, 1)).unwrap(), case["records"], "{}", ad.name);
            let announce = Packet { response: true, answers: records_for(ad, 1), ..Packet::default() };
            assert_eq!(hex(&encode_packet(&announce)), case["announce"].as_str().unwrap());
            let goodbye = Packet { response: true, answers: records_for(ad, 0), ..Packet::default() };
            assert_eq!(hex(&encode_packet(&goodbye)), case["goodbye"].as_str().unwrap());
        }
        for case in m["answers"].as_array().unwrap() {
            let questions: Vec<Question> = case["questions"].as_array().unwrap().iter().map(question_of).collect();
            let answers = answers_for(&ads[1], &questions);
            assert_eq!(serde_json::to_value(&answers).unwrap(), case["answers"], "{questions:?}");
            let multicast = Packet { response: true, answers: answers.clone(), ..Packet::default() };
            assert_eq!(hex(&encode_packet(&multicast)), case["multicast"].as_str().unwrap());
            let short = answers.into_iter().map(|r| Record { ttl: r.ttl.min(10), unique: Some(false), ..r }).collect();
            let legacy = Packet { id: 0x1234, response: true, questions, answers: short };
            assert_eq!(hex(&encode_packet(&legacy)), case["legacy"].as_str().unwrap());
        }
        let query: Vec<Question> = m["answers"][1]["questions"].as_array().unwrap().iter().map(question_of).collect();
        assert_eq!(
            hex(&encode_packet(&Packet { questions: query, ..Packet::default() })),
            m["query"].as_str().unwrap()
        );
        for case in m["decode"].as_array().unwrap() {
            let got = decode_packet(&unhex(case["hex"].as_str().unwrap()));
            assert_eq!(serde_json::to_value(got).unwrap(), case["packet"], "{}", case["name"]);
        }
    }

    #[test]
    fn lan_addresses_match_the_ts() {
        let g = golden();
        let spec = &g["ifaces"];
        for case in g["mdns"]["lanAddresses"].as_array().unwrap() {
            let nics = nics_of(&spec[case["ifaces"].as_str().unwrap()]);
            assert_eq!(json!(lan_addresses(&nics)), case["addresses"], "{}", case["ifaces"]);
        }
    }

    #[test]
    fn a_published_record_round_trips() {
        let ad = Advertisement {
            name: "Studio".into(),
            host: "studio".into(),
            addresses: vec!["192.168.1.20".into()],
            relay_url: Some("ws://studio.tail1234.ts.net:4400".into()),
            port: 4400,
        };
        let answers = records_for(&ad, 1);
        let back =
            decode_packet(&encode_packet(&Packet { response: true, answers: answers.clone(), ..Packet::default() }))
                .unwrap();
        let expected: Vec<Record> =
            answers.into_iter().map(|r| Record { unique: Some(r.unique == Some(true)), ..r }).collect();
        assert_eq!(back.answers, expected);
    }
}
