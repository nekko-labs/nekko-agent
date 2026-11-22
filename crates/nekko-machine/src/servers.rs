//! The web pages served on this computer (`servers:list`, issue #2824): what
//! the Agents panel's Browsers view lists, so a dev server can be opened
//! without an agent.
//!
//! Three steps, each best-effort. The listening TCP sockets come from `lsof`
//! (macOS, Linux) or `netstat -ano` (Windows); only ones reachable from this
//! computer count (loopback or every address). The serving process's name and
//! working folder come from `sysinfo`, so the panel can say which connected
//! folder a site runs from. Each port is then asked for `/` once, briefly: a
//! page is a reply that is HTML or a redirect; databases and JSON APIs are
//! left out, and so are this app's own processes and model servers.

use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A port some process is listening on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub port: u16,
    pub pid: u32,
    /// Listening on IPv6 only: ask `::1` rather than `127.0.0.1`.
    pub v6_only: bool,
}

/// A served web page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub url: String,
    pub port: u16,
    /// The page's `<title>`, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The serving process ("node", "python3").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    /// The serving process's working folder, matched to a connected folder by the window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Ports that are never a web page, so never asked: SSH, mail, DNS, printing,
/// databases and caches.
const NOT_WEB: &[u16] = &[22, 25, 53, 110, 143, 445, 587, 631, 993, 995, 1433, 3306, 5353, 5432, 6379, 11211, 27017];

/// This app's helpers and model servers: listed elsewhere, never as a site.
const OWN_NAMES: &[&str] = &[
    "nekkod",
    "nekko agent",
    "nekko-agent",
    "llama-server",
    "ggml-rpc-server",
    "whisper-server",
    "sd-server",
    "rpc-server",
];

/// Whether a socket's local address can be reached as localhost.
fn local_host(host: &str) -> Option<bool> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host {
        "*" | "0.0.0.0" | "127.0.0.1" | "localhost" => Some(false),
        "::" | "::1" => Some(true),
        _ => match host.parse::<IpAddr>().ok()? {
            IpAddr::V4(v4) => v4.is_loopback().then_some(false),
            IpAddr::V6(v6) => v6.is_loopback().then_some(true),
        },
    }
}

/// `host:port` with the port after the last colon (IPv6 hosts hold colons).
fn split_addr(addr: &str) -> Option<(&str, u16)> {
    let (host, port) = addr.rsplit_once(':')?;
    Some((host, port.parse().ok()?))
}

/// Merge one socket into the per-port list: IPv4 wins over IPv6-only.
fn add(found: &mut BTreeMap<u16, Listener>, port: u16, pid: u32, v6: bool) {
    if port == 0 || NOT_WEB.contains(&port) {
        return;
    }
    found.entry(port).and_modify(|l| l.v6_only &= v6).or_insert(Listener { port, pid, v6_only: v6 });
}

/// `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then one `n<addr>`
/// line per socket that process holds.
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut found = BTreeMap::new();
    let mut pid = 0u32;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.trim().parse().unwrap_or(0);
        } else if let Some(addr) = line.strip_prefix('n')
            && let Some((host, port)) = split_addr(addr.trim())
            && let Some(v6) = local_host(host)
            && pid != 0
        {
            add(&mut found, port, pid, v6);
        }
    }
    found.into_values().collect()
}

/// `netstat -ano -p TCP` and `-p TCPv6`: `TCP  127.0.0.1:5173  0.0.0.0:0  LISTENING  1234`.
pub fn parse_netstat(text: &str) -> Vec<Listener> {
    let mut found = BTreeMap::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let [proto, local, _, state, pid] = cols.as_slice() else { continue };
        if !proto.eq_ignore_ascii_case("tcp") || !state.eq_ignore_ascii_case("listening") {
            continue;
        }
        let (Some((host, port)), Ok(pid)) = (split_addr(local), pid.parse::<u32>()) else { continue };
        if let Some(v6) = local_host(host) {
            add(&mut found, port, pid, v6);
        }
    }
    found.into_values().collect()
}

/// A reply's status line and head: a page is a redirect, or HTML that is
/// not an error (a sign-in page's 401 counts; another app's internal 404 page
/// does not). Returns the page's title (empty when it has none), else `None`.
pub fn page_title(reply: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(reply);
    let (head, body) = text.split_once("\r\n\r\n").or_else(|| text.split_once("\n\n")).unwrap_or((&text, ""));
    let mut lines = head.lines();
    let status: u16 = lines.next()?.strip_prefix("HTTP/")?.split_whitespace().nth(1)?.parse().ok()?;
    let html = lines.any(|l| {
        l.split_once(':').is_some_and(|(k, v)| {
            k.trim().eq_ignore_ascii_case("content-type") && v.to_ascii_lowercase().contains("text/html")
        })
    });
    let redirect = (300..400).contains(&status);
    if !redirect && !(html && (status < 400 || status == 401)) {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    let title = lower
        .find("<title")
        .and_then(|at| Some(at + lower[at..].find('>')? + 1))
        .and_then(|from| Some(&body[from..from + lower[from..].find("</title")?]))
        .map(|t| decode_entities(&t.split_whitespace().collect::<Vec<_>>().join(" ")))
        .unwrap_or_default();
    Some(title)
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

/// Ask a port for `/` and read the start of the reply.
async fn ask(port: u16, v6: bool, timeout: Duration) -> Option<Vec<u8>> {
    let ip = if v6 { IpAddr::V6(Ipv6Addr::LOCALHOST) } else { IpAddr::V4(Ipv4Addr::LOCALHOST) };
    let work = async {
        let mut stream = tokio::net::TcpStream::connect(SocketAddr::new(ip, port)).await.ok()?;
        let host = if v6 { format!("[::1]:{port}") } else { format!("localhost:{port}") };
        let req = format!(
            "GET / HTTP/1.1\r\nHost: {host}\r\nAccept: text/html\r\nUser-Agent: nekko-agent\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::with_capacity(8192);
        let mut chunk = [0u8; 8192];
        // Enough for the head and a title near the top of the page.
        while buf.len() < 32 * 1024 {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            let lower = String::from_utf8_lossy(&buf).to_ascii_lowercase();
            if lower.contains("</title") || lower.contains("<body") {
                break;
            }
        }
        (!buf.is_empty()).then_some(buf)
    };
    tokio::time::timeout(timeout, work).await.ok().flatten()
}

/// Run a command hidden, with its stdout on success.
async fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(Path::new(cmd));
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()?;
    // lsof exits 1 when it finds nothing, with an empty stdout.
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every listening socket reachable as localhost.
pub async fn listeners() -> Vec<Listener> {
    if cfg!(windows) {
        let mut text = run("netstat", &["-ano", "-p", "TCP"]).await.unwrap_or_default();
        text.push('\n');
        text.push_str(&run("netstat", &["-ano", "-p", "TCPv6"]).await.unwrap_or_default());
        parse_netstat(&text)
    } else {
        parse_lsof(&run("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).await.unwrap_or_default())
    }
}

/// The name and working folder of each process, and this app's own pids.
/// Each pid's process name and working folder.
type ProcInfo = BTreeMap<u32, (String, Option<String>)>;

fn processes(pids: &[u32]) -> (ProcInfo, HashSet<u32>) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let wanted: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&wanted),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always).with_exe(UpdateKind::Never),
    );
    let me = std::process::id();
    let own_parent = sys.process(Pid::from_u32(me)).and_then(|p| p.parent()).map(|p| p.as_u32());
    let mut own: HashSet<u32> = [me].into_iter().chain(own_parent).collect();
    let mut out = BTreeMap::new();
    for pid in pids {
        let Some(p) = sys.process(Pid::from_u32(*pid)) else { continue };
        let name = p.name().to_string_lossy().trim_end_matches(".exe").to_string();
        let lower = name.to_ascii_lowercase();
        if OWN_NAMES.iter().any(|n| lower.starts_with(n)) {
            own.insert(*pid);
        }
        let cwd = p.cwd().map(|c| c.to_string_lossy().into_owned()).filter(|c| !c.is_empty() && c != "/");
        out.insert(*pid, (name, cwd));
    }
    (out, own)
}

/// The served pages now, in port order. Asks every port at once.
pub async fn servers() -> Vec<Server> {
    let found = listeners().await;
    let pids: Vec<u32> = found.iter().map(|l| l.pid).collect();
    let (procs, own) = tokio::task::spawn_blocking(move || processes(&pids)).await.unwrap_or_default();
    let asks = found.into_iter().filter(|l| !own.contains(&l.pid)).map(|l| async move {
        let reply = ask(l.port, l.v6_only, Duration::from_millis(1000)).await?;
        let title = page_title(&reply)?;
        Some((l, title))
    });
    let mut out = Vec::new();
    for (l, title) in join_all(asks).await.into_iter().flatten() {
        let (process, cwd) = procs.get(&l.pid).cloned().map_or((None, None), |(n, c)| (Some(n), c));
        let host = if l.v6_only { "[::1]" } else { "localhost" };
        out.push(Server {
            url: format!("http://{host}:{}/", l.port),
            port: l.port,
            title: (!title.is_empty()).then_some(title),
            process,
            cwd,
        });
    }
    out
}

/// Await every future, keeping order (a few dozen ports at most).
async fn join_all<F: std::future::Future + Send + 'static>(futs: impl Iterator<Item = F>) -> Vec<F::Output>
where
    F::Output: Send + 'static,
{
    let handles: Vec<_> = futs.map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_keeps_local_listeners_once_per_port() {
        let text = "p501\nn127.0.0.1:5173\nn[::1]:5173\np77\nn*:3000\np90\nn192.168.1.4:8080\np91\nn[::1]:4321\np92\nn*:5432\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                Listener { port: 3000, pid: 77, v6_only: false },
                Listener { port: 4321, pid: 91, v6_only: true },
                Listener { port: 5173, pid: 501, v6_only: false },
            ]
        );
    }

    #[test]
    fn netstat_reads_listening_rows() {
        let text = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100\n  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4242\n  TCP    10.0.0.5:139           0.0.0.0:0              LISTENING       4\n  TCP    127.0.0.1:8000         127.0.0.1:50000        ESTABLISHED     4242\n  TCP    [::1]:5173             [::]:0                 LISTENING       900\n";
        assert_eq!(
            parse_netstat(text),
            vec![
                Listener { port: 135, pid: 1100, v6_only: false },
                Listener { port: 5173, pid: 900, v6_only: true },
                Listener { port: 8000, pid: 4242, v6_only: false },
            ]
        );
    }

    #[test]
    fn a_page_is_html_or_a_redirect() {
        let html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<!doctype html><html><head><TITLE>\n  Vite &amp; React\n</TITLE>";
        assert_eq!(page_title(html).as_deref(), Some("Vite & React"));
        let redirect = b"HTTP/1.1 302 Found\r\nLocation: /login\r\n\r\n";
        assert_eq!(page_title(redirect).as_deref(), Some(""));
        let json = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}";
        assert_eq!(page_title(json), None);
        // Another app's internal server answering / with an error page.
        let missing = b"HTTP/1.1 404 Not Found\r\nX-Powered-By: Express\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<title>Error</title>";
        assert_eq!(page_title(missing), None);
        let sign_in = b"HTTP/1.1 401 Unauthorized\r\nContent-Type: text/html\r\n\r\n<title>Sign in</title>";
        assert_eq!(page_title(sign_in).as_deref(), Some("Sign in"));
        assert_eq!(page_title(b"-ERR unknown command\r\n"), None);
        let untitled = b"HTTP/1.0 200 OK\r\ncontent-type: TEXT/HTML\r\n\r\n<ul><li>a</li></ul>";
        assert_eq!(page_title(untitled).as_deref(), Some(""));
    }

    #[tokio::test]
    async fn asks_a_real_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<title>Hello</title>").await.unwrap();
        });
        let reply = ask(port, false, Duration::from_secs(2)).await.unwrap();
        assert_eq!(page_title(&reply).as_deref(), Some("Hello"));
    }
}
