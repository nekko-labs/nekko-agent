//! Two composer and chat channels the daemon answers without the TS host:
//! `image:fetch`, a port of `packages/host/src/remote-image.ts`, and
//! `attachment:import`, a port of `importAttachment` in
//! `packages/host/src/files.ts`.
//!
//! `image:fetch` hands the renderer a remote photo as an inert data URL. The
//! renderer never loads a remote URL itself (its CSP is `img-src 'self'
//! data:`), so a picture in a reply cannot beacon, set cookies or reach the
//! user's network on render. Instead the daemon fetches it under rules a
//! browser would not apply:
//!
//!  - http(s) only, default ports only, no credentials in the URL;
//!  - every address a host name resolves to must be public: loopback,
//!    private, link-local (cloud metadata), CGNAT, multicast and reserved
//!    ranges are refused. The check runs inside the client's own DNS
//!    resolver, so the address that is checked is the address that is dialed
//!    (no DNS-rebinding gap), and no proxy is used (a proxy would resolve the
//!    name itself);
//!  - redirects are followed by hand, at most five, each hop checked again;
//!  - no cookies, no auth, no referrer, no connection reuse, no transparent
//!    decompression; a fixed user agent;
//!  - a size cap and a time limit, and the bytes must *be* a PNG, JPEG, GIF,
//!    WebP or AVIF by their magic number, whatever the server's content type
//!    says. SVG is refused: it is a document, not a photo.

use crate::routes::Ctx;
use base64::Engine as _;
use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use nekko_tools::path::native as path;
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use url::Url;

/// Most bytes read from an image response (`IMAGE_MAX_BYTES`).
pub const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;
/// Longest one fetch may take, every redirect included (`IMAGE_TIMEOUT_MS`).
pub const IMAGE_TIMEOUT: Duration = Duration::from_millis(20_000);
/// Redirects followed before giving up (`IMAGE_MAX_REDIRECTS`).
pub const IMAGE_MAX_REDIRECTS: usize = 5;

/// Pasted attachments are capped so a stray paste cannot fill the data dir (`MAX_IMPORT`).
const MAX_IMPORT: usize = 50_000_000;

const LOCAL: &str = "Images from this computer or the local network are not loaded.";
const ACCEPT: &str = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1";
const USER_AGENT: &str = "Mozilla/5.0 (compatible; NekkoAgent/1.0; +https://nekkoagent.com)";

/// `image:fetch` and `attachment:import`; None for any other channel, and for
/// `attachment:import` when the daemon does not know the data directory (the
/// backend answers it then).
pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    match channel {
        "image:fetch" => {
            // `String(url ?? '')`.
            let raw = match args.first() {
                None | Some(Value::Null) => String::new(),
                Some(v) => nekko_js::display(v),
            };
            Some(fetch_remote_image(&raw).await.map(|img| img.to_json()).map_err(|e| e.message))
        }
        "attachment:import" => {
            let store = ctx.sessions.as_ref()?;
            let data_dir = store.dir().parent()?.to_string_lossy().into_owned();
            Some(attachment_import(data_dir, args).await)
        }
        _ => None,
    }
}

async fn attachment_import(data_dir: String, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    // The TS calls `sessionId.replace` and `name.split`, which throw on anything but a string.
    let Some(session_id) = arg(0).as_str().map(str::to_owned) else {
        return Err("sessionId.replace is not a function".into());
    };
    let Some(name) = arg(1).as_str().map(str::to_owned) else {
        return Err("name.split is not a function".into());
    };
    // `regex.exec(dataUrl)` reads its argument as a string.
    let data_url = match args.get(2) {
        None => "undefined".to_string(),
        Some(v) => nekko_js::display(v),
    };
    tokio::task::spawn_blocking(move || import_attachment(&data_dir, &session_id, &name, &data_url).map(Value::String))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// image:fetch

/// What `image:fetch` resolves to (`RemoteImage` in packages/shared).
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteImage {
    /// `data:image/<png|jpeg|gif|webp|avif>;base64,...`
    pub data_url: String,
    pub mime: String,
    pub bytes: usize,
    /// Where the image actually came from, after redirects.
    pub final_url: String,
}

impl RemoteImage {
    fn to_json(&self) -> Value {
        json!({ "dataUrl": self.data_url, "mime": self.mime, "bytes": self.bytes, "finalUrl": self.final_url })
    }
}

/// `RemoteImageError`: a code for tests and callers, and the message the UI shows.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> ImageError {
    ImageError { code, message: message.into() }
}

/// `checkImageUrl`: a URL the fetcher may try at all (before any DNS):
/// http(s), default port, no userinfo.
pub fn check_image_url(raw: &str) -> Result<Url, ImageError> {
    let url = Url::parse(nekko_js::trim(raw)).map_err(|_| err("url", "Not a URL."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(err("url", "Only http and https images can be shown."));
    }
    if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
        return Err(err("url", "Image URLs with credentials are not loaded."));
    }
    // A non-default port is how internal services are usually reached; photos
    // are not served there. `port()` is None for the scheme's default, as
    // `url.port` is '' in the TS.
    if url.port().is_some_and(|p| p != 80 && p != 443) {
        return Err(err("blocked", "Images are only loaded from standard web ports."));
    }
    let hostname = url.host_str().unwrap_or_default();
    let hostname = hostname.strip_prefix('[').unwrap_or(hostname);
    let host = hostname.strip_suffix(']').unwrap_or(hostname).to_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
    {
        return Err(err("blocked", LOCAL));
    }
    if is_ip(&host) && !is_public_address(&host) {
        return Err(err("blocked", LOCAL));
    }
    Ok(url)
}

/// `net.isIP(s) !== 0`.
fn is_ip(s: &str) -> bool {
    s.parse::<IpAddr>().is_ok()
}

/// `publicIPv4`.
fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false; // this-net, private, loopback, multicast + reserved
    }
    if a == 100 && (64..=127).contains(&b) {
        return false; // CGNAT
    }
    if a == 169 && b == 254 {
        return false; // link-local, cloud metadata
    }
    if a == 172 && (16..=31).contains(&b) {
        return false;
    }
    if a == 192 && b == 168 {
        return false;
    }
    if a == 192 && b == 0 && (c == 0 || c == 2) {
        return false; // IETF, TEST-NET-1
    }
    if a == 198 && (b == 18 || b == 19) {
        return false; // benchmarking
    }
    if a == 198 && b == 51 && c == 100 {
        return false; // TEST-NET-2
    }
    if a == 203 && b == 0 && c == 113 {
        return false; // TEST-NET-3
    }
    true
}

/// The IPv4 address in an IPv6 address's last two groups.
fn tail_ipv4(g: &[u16; 8]) -> Ipv4Addr {
    Ipv4Addr::new((g[6] >> 8) as u8, g[6] as u8, (g[7] >> 8) as u8, g[7] as u8)
}

/// The IPv6 half of `isPublicAddress`, on its eight groups.
fn public_ipv6(ip: Ipv6Addr) -> bool {
    let g = ip.segments();
    if g.iter().all(|&x| x == 0) {
        return false; // ::
    }
    if g[..7].iter().all(|&x| x == 0) && g[7] == 1 {
        return false; // ::1
    }
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
    if g[..5].iter().all(|&x| x == 0) && (g[5] == 0xffff || g[5] == 0) {
        return public_ipv4(tail_ipv4(&g));
    }
    if g[0] == 0x64 && g[1] == 0xff9b {
        return public_ipv4(tail_ipv4(&g)); // NAT64
    }
    if (g[0] & 0xfe00) == 0xfc00 {
        return false; // unique local
    }
    if (g[0] & 0xffc0) == 0xfe80 {
        return false; // link-local
    }
    if (g[0] & 0xffc0) == 0xfec0 {
        return false; // site-local (deprecated)
    }
    if (g[0] & 0xff00) == 0xff00 {
        return false; // multicast
    }
    if g[0] == 0x2001 && g[1] == 0x0db8 {
        return false; // documentation
    }
    if g[0] == 0x2002 {
        return false; // 6to4 can tunnel to any IPv4, private ones included
    }
    if g[0] == 0x2001 && g[1] == 0 {
        return false; // Teredo, same reason
    }
    true
}

/// A resolved address is public: the rules of `isPublicAddress` on a parsed address.
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_ipv4(v4),
        IpAddr::V6(v6) => public_ipv6(v6),
    }
}

/// `isPublicAddress`: true only for an address on the public internet.
/// Anything unparseable is not.
pub fn is_public_address(ip: &str) -> bool {
    let bare = ip.split('%').next().unwrap_or_default();
    if bare.parse::<Ipv4Addr>().is_ok() {
        // The TS reads the dotted quad from the whole string, zone included, so a zone fails it.
        return ip.parse::<Ipv4Addr>().is_ok_and(public_ipv4);
    }
    bare.parse::<Ipv6Addr>().is_ok_and(public_ipv6)
}

/// `sniffImageType`: the raster type the bytes are, by magic number, or None.
pub fn sniff_image_type(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if b.len() >= 6 && b.starts_with(b"GIF8") && (b[4] == 0x37 || b[4] == 0x39) && b[5] == 0x61 {
        return Some("image/gif");
    }
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
        return Some("image/avif");
    }
    None
}

/// Why one GET failed: a refused address (`EBLOCKED`), or the error's
/// `code ?? message` as the TS reports it.
#[derive(Debug, Clone, PartialEq)]
pub enum GetError {
    Blocked,
    Failed(String),
}

/// One GET's answer: status, the redirect target, the declared length and the body.
pub struct ImageResponse {
    pub status: u16,
    pub location: Option<String>,
    pub content_length: Option<f64>,
    /// Chunks until the end; an `Err` is an interrupted download. Dropping it closes the response.
    pub body: BoxStream<'static, Result<Bytes, ()>>,
}

/// `ImageGet`: one GET as a seam for tests.
pub trait ImageGet: Send + Sync {
    fn get<'a>(&'a self, url: &'a Url) -> BoxFuture<'a, Result<ImageResponse, GetError>>;
}

/// A name lookup: the addresses a host name resolves to.
type Lookup = dyn Fn(String) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> + Send + Sync;

/// A name that resolved to a private or local address (`EBLOCKED`).
#[derive(Debug)]
struct Blocked(String);

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} resolves to a private or local address.", self.0)
    }
}

impl std::error::Error for Blocked {}

/// A name that did not resolve (`ENOTFOUND`).
#[derive(Debug)]
struct NotFound(std::io::Error);

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for NotFound {}

/// `publicOnlyLookup`: a resolver that resolves as usual and then refuses the
/// connection unless every address is public. Checking *all* of them, not
/// just the first, stops a name that answers with one public and one private
/// address from being dialed on the private one by Happy Eyeballs.
struct PublicOnly {
    lookup: Arc<Lookup>,
}

impl PublicOnly {
    fn system() -> Self {
        Self {
            lookup: Arc::new(|host: String| {
                Box::pin(async move { Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.collect()) })
            }),
        }
    }

    async fn resolve_public(&self, host: String) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
        let list = (self.lookup)(host.clone()).await.map_err(NotFound)?;
        if list.is_empty() || list.iter().any(|a| !public_ip(a.ip())) {
            return Err(Box::new(Blocked(host)));
        }
        Ok(list)
    }
}

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let me = Self { lookup: Arc::clone(&self.lookup) };
        let host = name.as_str().to_string();
        Box::pin(async move {
            let list = me.resolve_public(host).await?;
            Ok(Box::new(list.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The client every real GET goes out on: the public-only resolver, no
/// proxy, no redirects, no cookies or referrer, no pooled connections, and
/// the bytes as sent (another crate in the build may turn on reqwest's
/// decompression, which `agent: false` Node requests never do).
fn image_client(resolver: PublicOnly) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(resolver))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .pool_max_idle_per_host(0)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|e| e.to_string())
}

/// `nodeImageGet`: the real GET.
pub struct NetImageGet {
    client: Result<reqwest::Client, String>,
}

impl NetImageGet {
    fn shared() -> &'static NetImageGet {
        static NET: OnceLock<NetImageGet> = OnceLock::new();
        NET.get_or_init(|| NetImageGet { client: image_client(PublicOnly::system()) })
    }
}

/// A header value as Node reads it (latin1).
fn latin1(v: &reqwest::header::HeaderValue) -> String {
    v.as_bytes().iter().map(|&b| char::from(b)).collect()
}

/// A reqwest failure as the TS reports a request error: `EBLOCKED`, else the
/// Node error code this failure would have carried, else its message.
fn get_error(e: &reqwest::Error) -> GetError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = source {
        if s.downcast_ref::<Blocked>().is_some() {
            return GetError::Blocked;
        }
        if s.downcast_ref::<NotFound>().is_some() {
            return GetError::Failed("ENOTFOUND".into());
        }
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind as K;
            let code = match io.kind() {
                K::ConnectionRefused => Some("ECONNREFUSED"),
                K::ConnectionReset => Some("ECONNRESET"),
                K::ConnectionAborted => Some("ECONNABORTED"),
                K::TimedOut => Some("ETIMEDOUT"),
                K::HostUnreachable => Some("EHOSTUNREACH"),
                K::NetworkUnreachable => Some("ENETUNREACH"),
                K::BrokenPipe => Some("EPIPE"),
                _ => None,
            };
            if let Some(code) = code {
                return GetError::Failed(code.into());
            }
        }
        source = s.source();
    }
    GetError::Failed(e.to_string())
}

impl ImageGet for NetImageGet {
    fn get<'a>(&'a self, url: &'a Url) -> BoxFuture<'a, Result<ImageResponse, GetError>> {
        Box::pin(async move {
            let client = self.client.as_ref().map_err(|e| GetError::Failed(e.clone()))?;
            let res = client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, ACCEPT)
                .header(reqwest::header::USER_AGENT, USER_AGENT)
                .send()
                .await
                .map_err(|e| get_error(&e))?;
            let headers = res.headers();
            let location = headers.get(reqwest::header::LOCATION).map(latin1);
            // `Number(res.headers['content-length'])`, kept when finite.
            let content_length = headers
                .get(reqwest::header::CONTENT_LENGTH)
                .map(|v| nekko_js::string_to_number(&latin1(v)))
                .filter(|n| n.is_finite());
            let status = res.status().as_u16();
            let body = futures_util::stream::unfold(Some(res), |res| async move {
                let mut res = res?;
                match res.chunk().await {
                    Ok(Some(chunk)) => Some((Ok(chunk), Some(res))),
                    Ok(None) => None,
                    Err(_) => Some((Err(()), None)),
                }
            })
            .boxed();
            Ok(ImageResponse { status, location, content_length, body })
        })
    }
}

/// `fetchRemoteImage`: fetch a remote image under the rules above.
pub async fn fetch_remote_image(raw_url: &str) -> Result<RemoteImage, ImageError> {
    fetch_remote_image_with(raw_url, NetImageGet::shared()).await
}

/// `fetchRemoteImage` with its `get` seam.
pub async fn fetch_remote_image_with(raw_url: &str, get: &dyn ImageGet) -> Result<RemoteImage, ImageError> {
    let mut url = check_image_url(raw_url)?;
    match tokio::time::timeout(IMAGE_TIMEOUT, fetch_hops(&mut url, get)).await {
        Ok(result) => result,
        Err(_) => Err(err("timeout", "The image took too long to load.")),
    }
}

fn too_large() -> ImageError {
    let mb = nekko_js::number_to_string(IMAGE_MAX_BYTES as f64 / 1024.0 / 1024.0);
    err("too-large", format!("The image is larger than {mb} MB."))
}

async fn fetch_hops(url: &mut Url, get: &dyn ImageGet) -> Result<RemoteImage, ImageError> {
    let mut hop = 0;
    loop {
        let res = get.get(url).await.map_err(|e| match e {
            GetError::Blocked => err("blocked", LOCAL),
            GetError::Failed(code) => err("network", format!("Could not load the image ({code}).")),
        })?;
        // A redirect needs a non-empty Location, as the TS's truthy check does.
        if let Some(location) = res.location.as_deref().filter(|l| (300..400).contains(&res.status) && !l.is_empty()) {
            if hop >= IMAGE_MAX_REDIRECTS {
                return Err(err("network", "The image redirected too many times."));
            }
            let next = url.join(location).map_err(|_| err("url", "The image redirected to an invalid address."))?;
            // Never step down from https to http on a redirect.
            if url.scheme() == "https" && next.scheme() == "http" {
                return Err(err("blocked", "The image redirected from https to http."));
            }
            *url = check_image_url(next.as_str())?;
            hop += 1;
            continue;
        }
        if res.status != 200 {
            return Err(err("status", format!("The image server answered HTTP {}.", res.status)));
        }
        if res.content_length.is_some_and(|n| n > IMAGE_MAX_BYTES as f64) {
            return Err(too_large());
        }
        let mut body = res.body;
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|()| err("network", "The image download was interrupted."))?;
            if bytes.len() + chunk.len() > IMAGE_MAX_BYTES {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        let Some(mime) = sniff_image_type(&bytes) else {
            return Err(err("not-image", "That address is not a PNG, JPEG, GIF, WebP or AVIF image."));
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(RemoteImage {
            data_url: format!("data:{mime};base64,{b64}"),
            mime: mime.to_string(),
            bytes: bytes.len(),
            final_url: url.to_string(),
        });
    }
}

// ---------------------------------------------------------------------------
// attachment:import

/// The base64 payload of `/^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/`.
///
/// Neither group before the payload can match a comma, so the pattern holds
/// exactly when the text between `data:` and the first comma ends in
/// `;base64` and everything after that comma is one or more base64 letters,
/// `=` or JavaScript whitespace. Matched by hand: a backtracking engine over
/// a 50 MB paste is slow.
fn data_url_payload(data_url: &str) -> Option<&str> {
    let rest = data_url.strip_prefix("data:")?;
    let (head, payload) = rest.split_once(',')?;
    if !head.ends_with(";base64") || payload.is_empty() {
        return None;
    }
    let ok =
        payload.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=') || nekko_js::is_js_space(c));
    ok.then_some(payload)
}

/// `sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'chat'`. The
/// pattern has no `u` flag, so a character outside the BMP is two code
/// units and becomes two underscores.
fn safe_session(session_id: &str) -> String {
    let mut out = String::new();
    for c in session_id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    let out = nekko_js::slice16(&out, 64).to_string();
    if out.is_empty() { "chat".into() } else { out }
}

/// `(name.split(/[\\/]/).pop() ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim() || 'pasted'`.
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['\\', '/']).next().unwrap_or_default();
    let replaced: String = last
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'..='\u{1f}') { '_' } else { c })
        .collect();
    let base = nekko_js::trim(&replaced);
    if base.is_empty() { "pasted".into() } else { base.to_string() }
}

/// `importAttachment`: save bytes the user pasted into the composer (a PDF
/// copied from a browser, a file from an email) as a real file under
/// `<dataDir>/attachments/<session>/`, so it can be attached like anything
/// picked from disk. The name is reduced to a safe basename, and a clash gets
/// a numeric suffix rather than overwriting. Returns the written path.
pub fn import_attachment(data_dir: &str, session_id: &str, name: &str, data_url: &str) -> Result<String, String> {
    import_attachment_capped(data_dir, session_id, name, data_url, MAX_IMPORT)
}

fn import_attachment_capped(
    data_dir: &str,
    session_id: &str,
    name: &str,
    data_url: &str,
    max: usize,
) -> Result<String, String> {
    let payload = data_url_payload(data_url).ok_or("Attachment must be a base64 data URL.")?;
    // `Buffer.from(s, 'base64')`, which skips whitespace.
    let bytes = nekko_web::browser::decode_base64(payload);
    if bytes.len() > max {
        return Err("Attachment is larger than 50 MB.".into());
    }
    let dir = path::join(&[data_dir, "attachments", &safe_session(session_id)]);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = safe_name(name);
    let ext = path::extname(&base);
    // `base.slice(0, -ext.length)`: the extension is a suffix of the name.
    let stem = &base[..base.len() - ext.len()];
    let mut target = path::join(&[&dir, &base]);
    let mut n = 2;
    while std::path::Path::new(&target).exists() {
        target = path::join(&[&dir, &format!("{stem}-{n}{ext}")]);
        n += 1;
    }
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];

    #[derive(Default, Clone)]
    struct Route {
        status: Option<u16>,
        location: Option<String>,
        body: Vec<Vec<u8>>,
        length: Option<f64>,
    }

    /// A fake server: one response per URL, as the TS tests' `server`.
    #[derive(Default)]
    struct Server {
        routes: HashMap<String, Route>,
        hits: Mutex<Vec<String>>,
        blocked: bool,
    }

    impl ImageGet for Server {
        fn get<'a>(&'a self, url: &'a Url) -> BoxFuture<'a, Result<ImageResponse, GetError>> {
            Box::pin(async move {
                self.hits.lock().unwrap().push(url.to_string());
                if self.blocked {
                    return Err(GetError::Blocked);
                }
                let r = self.routes.get(url.as_str()).cloned().ok_or(GetError::Failed("ENOTFOUND".into()))?;
                let body = futures_util::stream::iter(r.body.into_iter().map(|c| Ok(Bytes::from(c)))).boxed();
                Ok(ImageResponse {
                    status: r.status.unwrap_or(200),
                    location: r.location,
                    content_length: r.length,
                    body,
                })
            })
        }
    }

    fn server(routes: &[(&str, Route)]) -> Server {
        Server { routes: routes.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), ..Default::default() }
    }

    fn body(chunks: &[&[u8]]) -> Route {
        Route { body: chunks.iter().map(|c| c.to_vec()).collect(), ..Default::default() }
    }

    fn redirect(status: u16, to: &str) -> Route {
        Route { status: Some(status), location: Some(to.into()), ..Default::default() }
    }

    #[test]
    fn public_addresses_pass_and_local_ones_do_not() {
        for ip in ["8.8.8.8", "151.101.1.69", "2606:4700::6810:84e5", "::ffff:8.8.8.8"] {
            assert!(is_public_address(ip), "{ip} should be public");
        }
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12::3",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:7f00:1",
            "64:ff9b::a00:1",
            "2002:c0a8:101::",
            "2001:0:4136::",
            "2001:db8::1",
            "not-an-ip",
            "8.8.8.8%eth0",
            "fe80::1%eth0",
        ] {
            assert!(!is_public_address(ip), "{ip} should be refused");
        }
        assert!(is_public_address("2606:4700::1%eth0"));
    }

    #[test]
    fn image_urls_are_checked_before_any_dns() {
        assert_eq!(check_image_url("https://example.com/a.jpg").unwrap().host_str(), Some("example.com"));
        assert_eq!(check_image_url("http://8.8.8.8/a.png").unwrap().host_str(), Some("8.8.8.8"));
        assert!(check_image_url("  https://example.com:443/a.jpg\n").is_ok());
        assert!(check_image_url("http://example.com:443/a.jpg").is_ok());
        for (url, code) in [
            ("file:///etc/passwd", "url"),
            ("javascript:alert(1)", "url"),
            ("data:image/png;base64,AA", "url"),
            ("ftp://x.com/a.png", "url"),
            ("https://user:pw@example.com/a.png", "url"),
            ("https://user@example.com/a.png", "url"),
            ("https://example.com:8080/a.png", "blocked"),
            ("http://localhost/a.png", "blocked"),
            ("http://LOCALHOST/a.png", "blocked"),
            ("http://app.localhost/a.png", "blocked"),
            ("http://printer.local/a.png", "blocked"),
            ("http://metadata.google.internal/a.png", "blocked"),
            ("http://router.home.arpa/a.png", "blocked"),
            ("http://127.0.0.1/a.png", "blocked"),
            ("http://0x7f.1/a.png", "blocked"),
            ("http://2130706433/a.png", "blocked"),
            ("http://[::1]/a.png", "blocked"),
            ("http://169.254.169.254/latest/meta-data", "blocked"),
            ("http://[::ffff:10.0.0.1]/a.png", "blocked"),
            ("not a url", "url"),
        ] {
            assert_eq!(check_image_url(url).unwrap_err().code, code, "{url}");
        }
        assert_eq!(check_image_url("not a url").unwrap_err().message, "Not a URL.");
        assert_eq!(check_image_url("http://127.0.0.1/").unwrap_err().message, LOCAL);
        assert_eq!(
            check_image_url("https://example.com:8080/").unwrap_err().message,
            "Images are only loaded from standard web ports."
        );
    }

    fn fake_lookup(answers: &'static [&'static str]) -> PublicOnly {
        PublicOnly {
            lookup: Arc::new(move |_host: String| {
                Box::pin(async move { Ok(answers.iter().map(|a| SocketAddr::new(a.parse().unwrap(), 0)).collect()) })
            }),
        }
    }

    #[tokio::test]
    async fn the_resolver_refuses_any_private_answer() {
        let ok = fake_lookup(&["93.184.216.34"]).resolve_public("example.com".into()).await.unwrap();
        assert_eq!(ok, vec![SocketAddr::new("93.184.216.34".parse().unwrap(), 0)]);
        let rebind = fake_lookup(&["127.0.0.1"]).resolve_public("example.com".into()).await.unwrap_err();
        assert_eq!(rebind.to_string(), "example.com resolves to a private or local address.");
        assert!(fake_lookup(&["93.184.216.34", "10.0.0.5"]).resolve_public("example.com".into()).await.is_err());
        assert!(fake_lookup(&[]).resolve_public("example.com".into()).await.is_err());
    }

    #[tokio::test]
    async fn a_real_request_to_a_rebound_name_is_blocked_before_dialing() {
        // The fake resolver answers loopback; nothing is dialed and no real DNS is asked.
        let get = NetImageGet { client: image_client(fake_lookup(&["127.0.0.1"])) };
        let url = Url::parse("http://rebind.example.com/a.png").unwrap();
        assert_eq!(get.get(&url).await.err(), Some(GetError::Blocked));
        let e = fetch_remote_image_with("http://rebind.example.com/a.png", &get).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("blocked", LOCAL));
    }

    #[test]
    fn images_are_recognised_by_their_bytes() {
        assert_eq!(sniff_image_type(PNG), Some("image/png"));
        assert_eq!(sniff_image_type(JPEG), Some("image/jpeg"));
        assert_eq!(sniff_image_type(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image_type(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(sniff_image_type(b"<svg onload=\"alert(1)\"/>"), None);
        assert_eq!(sniff_image_type(b"<!doctype html>"), None);
        assert_eq!(sniff_image_type(b""), None);
    }

    #[tokio::test]
    async fn returns_an_inert_data_url_typed_by_the_bytes() {
        let s = server(&[("https://cdn.example.com/a.jpg", body(&[&JPEG[..2], &JPEG[2..]]))]);
        let img = fetch_remote_image_with("https://cdn.example.com/a.jpg", &s).await.unwrap();
        assert_eq!(img.mime, "image/jpeg");
        assert_eq!(img.data_url, "data:image/jpeg;base64,/9j/4AECAw==");
        assert_eq!(img.bytes, JPEG.len());
        let keys: Vec<String> = img.to_json().as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["dataUrl", "mime", "bytes", "finalUrl"]);
    }

    #[tokio::test]
    async fn follows_a_public_redirect_and_reports_where_the_image_came_from() {
        let s = server(&[
            ("https://example.com/photo", redirect(302, "/real.png")),
            ("https://example.com/real.png", body(&[PNG])),
        ]);
        let img = fetch_remote_image_with("https://example.com/photo", &s).await.unwrap();
        assert_eq!(*s.hits.lock().unwrap(), ["https://example.com/photo", "https://example.com/real.png"]);
        assert_eq!(img.final_url, "https://example.com/real.png");
    }

    #[tokio::test]
    async fn refuses_a_redirect_into_the_local_network_or_down_to_http() {
        let s = server(&[
            ("https://example.com/a", redirect(301, "http://169.254.169.254/latest/meta-data")),
            ("https://example.com/b", redirect(301, "http://example.com/b.png")),
        ]);
        assert_eq!(fetch_remote_image_with("https://example.com/a", &s).await.unwrap_err().code, "blocked");
        let e = fetch_remote_image_with("https://example.com/b", &s).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("blocked", "The image redirected from https to http."));
    }

    #[tokio::test]
    async fn stops_after_too_many_redirects() {
        let routes: Vec<(String, Route)> =
            (0..10).map(|i| (format!("https://example.com/{i}"), redirect(302, &format!("/{}", i + 1)))).collect();
        let s = Server { routes: routes.into_iter().collect(), ..Default::default() };
        let e = fetch_remote_image_with("https://example.com/0", &s).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("network", "The image redirected too many times."));
        // The first request plus five redirects followed.
        assert_eq!(s.hits.lock().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn refuses_bodies_that_are_not_images() {
        let s = server(&[("https://example.com/a.png", body(&[b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"]))]);
        let e = fetch_remote_image_with("https://example.com/a.png", &s).await.unwrap_err();
        assert_eq!(
            (e.code, e.message.as_str()),
            ("not-image", "That address is not a PNG, JPEG, GIF, WebP or AVIF image.")
        );
    }

    #[tokio::test]
    async fn caps_the_size_by_header_and_by_bytes_read() {
        let mut declared = body(&[PNG]);
        declared.length = Some(IMAGE_MAX_BYTES as f64 + 1.0);
        let big = server(&[("https://example.com/a.png", declared)]);
        let e = fetch_remote_image_with("https://example.com/a.png", &big).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("too-large", "The image is larger than 10 MB."));
        let mut chunk = vec![0u8; 1024 * 1024];
        chunk[..PNG.len()].copy_from_slice(PNG);
        let lying = server(&[("https://example.com/b.png", Route { body: vec![chunk; 11], ..Default::default() })]);
        assert_eq!(fetch_remote_image_with("https://example.com/b.png", &lying).await.unwrap_err().code, "too-large");
    }

    #[tokio::test]
    async fn reports_non_200_answers_and_failed_lookups_plainly() {
        let s = server(&[("https://example.com/404.png", Route { status: Some(404), ..Default::default() })]);
        let e = fetch_remote_image_with("https://example.com/404.png", &s).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("status", "The image server answered HTTP 404."));
        let e = fetch_remote_image_with("https://nowhere.example.com/a.png", &s).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("network", "Could not load the image (ENOTFOUND)."));
        let blocked = Server { blocked: true, ..Default::default() };
        let e = fetch_remote_image_with("https://rebind.example.com/a.png", &blocked).await.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), ("blocked", LOCAL));
    }

    #[tokio::test]
    async fn a_redirect_without_a_location_is_an_answer() {
        let s = server(&[(
            "https://example.com/a.png",
            Route { status: Some(302), location: Some(String::new()), ..Default::default() },
        )]);
        assert_eq!(
            fetch_remote_image_with("https://example.com/a.png", &s).await.unwrap_err().message,
            "The image server answered HTTP 302."
        );
    }

    fn temp_dir(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("nekkod-remote-image-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn attachments_are_saved_under_the_chat_with_a_safe_name_and_never_overwrite() {
        let data_dir = temp_dir("attach");
        let url = format!("data:application/pdf;base64,{}", b64(b"%PDF-1.4 hello"));
        let first = import_attachment(&data_dir, "sess/1", "../evil:name?.pdf", &url).unwrap();
        let dir = path::join(&[&data_dir, "attachments", "sess_1"]);
        assert_eq!(first, path::join(&[&dir, "evil_name_.pdf"]));
        assert_eq!(std::fs::read(&first).unwrap(), b"%PDF-1.4 hello");
        let second = import_attachment(&data_dir, "sess/1", "evil_name_.pdf", &url).unwrap();
        assert_eq!(second, path::join(&[&dir, "evil_name_-2.pdf"]));
        let third = import_attachment(&data_dir, "sess/1", "C:\\Users\\me\\evil_name_.pdf", &url).unwrap();
        assert_eq!(third, path::join(&[&dir, "evil_name_-3.pdf"]));
        assert!(std::path::Path::new(&first).exists());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn attachment_names_and_sessions_are_sanitized_as_the_ts_does() {
        assert_eq!(safe_session("sess/1"), "sess_1");
        assert_eq!(safe_session(""), "chat");
        assert_eq!(safe_session("a\u{1F600}b"), "a__b");
        assert_eq!(safe_session(&"x".repeat(100)).len(), 64);
        assert_eq!(safe_name("a/b\\c.txt"), "c.txt");
        assert_eq!(safe_name("dir/"), "pasted");
        assert_eq!(safe_name("  <a>|\"b\"*?\u{7}.txt \u{3000}"), "_a___b____.txt");
        // Control characters are replaced before the trim, so a tab survives as `_`.
        assert_eq!(safe_name("\t "), "_");
        assert_eq!(safe_name(" \u{3000} "), "pasted");
    }

    #[test]
    fn dotfiles_and_extensionless_names_get_the_suffix_on_the_whole_name() {
        let data_dir = temp_dir("dotfile");
        let url = format!("data:;base64,{}", b64(b"KEY=1"));
        let dir = path::join(&[&data_dir, "attachments", "chat"]);
        assert_eq!(import_attachment(&data_dir, "", ".env", &url).unwrap(), path::join(&[&dir, ".env"]));
        assert_eq!(import_attachment(&data_dir, "", ".env", &url).unwrap(), path::join(&[&dir, ".env-2"]));
        assert_eq!(import_attachment(&data_dir, "", "", &url).unwrap(), path::join(&[&dir, "pasted"]));
        assert_eq!(import_attachment(&data_dir, "", "pasted", &url).unwrap(), path::join(&[&dir, "pasted-2"]));
        assert_eq!(import_attachment(&data_dir, "", "a.tar.gz", &url).unwrap(), path::join(&[&dir, "a.tar.gz"]));
        assert_eq!(import_attachment(&data_dir, "", "a.tar.gz", &url).unwrap(), path::join(&[&dir, "a.tar-2.gz"]));
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn attachment_payloads_must_be_base64_data_urls() {
        let data_dir = temp_dir("bad");
        for bad in [
            "hello",
            "data:text/plain,hello",
            "data:text/plain;base64,",
            "data:text/plain;base64,aGk=!",
            "data:text/plain;base64,aGk,=",
            "data:text/plain;base64x,aGk=",
            "DATA:text/plain;base64,aGk=",
        ] {
            assert_eq!(
                import_attachment(&data_dir, "s", "a.txt", bad).unwrap_err(),
                "Attachment must be a base64 data URL.",
                "{bad}"
            );
        }
        // Parameters before `;base64`, and whitespace inside the payload, are fine.
        let ok = import_attachment(&data_dir, "s", "a.txt", "data:text/plain;charset=utf-8;base64,aG\r\n k=\u{3000}")
            .unwrap();
        assert_eq!(std::fs::read(ok).unwrap(), b"hi");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn attachments_over_the_cap_are_refused_before_anything_is_written() {
        let data_dir = temp_dir("cap");
        let url = format!("data:application/octet-stream;base64,{}", b64(&[7u8; 11]));
        assert!(import_attachment_capped(&data_dir, "s", "a.bin", &url, 11).is_ok());
        let e = import_attachment_capped(&data_dir, "s", "b.bin", &url, 10).unwrap_err();
        assert_eq!(e, "Attachment is larger than 50 MB.");
        assert!(!std::path::Path::new(&path::join(&[&data_dir, "attachments", "s", "b.bin"])).exists());
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
