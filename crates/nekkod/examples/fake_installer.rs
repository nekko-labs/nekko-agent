//! A stand-in for the NSIS installer in the updater's tests: never installs
//! anything. It writes the arguments it was started with beside itself
//! (`<name>.ran.json`), so a test can check that the daemon ran the
//! downloaded file with electron-updater's silent-update arguments, detached,
//! after the checksum held.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = std::env::current_exe().unwrap_or_default().with_extension("ran.json");
    let body = serde_json::json!({ "args": args, "pid": std::process::id() }).to_string();
    let _ = std::fs::write(out, body);
}
