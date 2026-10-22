//! Real-pty tests. The flood tests re-run this test binary as the program in
//! the terminal (see `producer`), so they need no platform-specific tool that
//! can write megabytes quickly.

use nekko_term::{CreateSpec, HIGH_WATER, Registry, RegistryEvent, ShellOption, StreamMsg, TerminalViewer};
use std::time::{Duration, Instant};

const PRODUCE_ENV: &str = "NEKKO_TERM_TEST_PRODUCE";

/// Not a test of its own: when the env var is set, this process is the
/// program inside the pty and writes that many bytes of output.
#[test]
fn producer() {
    let Ok(n) = std::env::var(PRODUCE_ENV) else {
        return;
    };
    use std::io::Write;
    let n: usize = n.parse().unwrap();
    let line = [b'x'; 1023];
    let mut out = std::io::stdout().lock();
    let mut written = 0;
    while written < n {
        out.write_all(&line).unwrap();
        out.write_all(b"\n").unwrap();
        written += 1024;
    }
    out.flush().unwrap();
}

fn self_as_producer() -> ShellOption {
    ShellOption {
        id: "producer".into(),
        label: "producer".into(),
        path: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
        args: Some(vec!["--exact".into(), "producer".into(), "--nocapture".into(), "--test-threads=1".into()]),
    }
}

fn echo(text: &str) -> ShellOption {
    if cfg!(windows) {
        ShellOption {
            id: "cmd".into(),
            label: "cmd".into(),
            path: "cmd.exe".into(),
            args: Some(vec!["/c".into(), format!("echo {text}")]),
        }
    } else {
        ShellOption {
            id: "sh".into(),
            label: "sh".into(),
            path: "/bin/sh".into(),
            args: Some(vec!["-c".into(), format!("echo {text}")]),
        }
    }
}

fn spec(shell: ShellOption) -> CreateSpec {
    CreateSpec {
        title: None,
        workspace_id: None,
        session_id: None,
        cwd: std::env::temp_dir(),
        shell,
        cols: 120,
        rows: 30,
        env: vec![],
    }
}

fn producing(bytes: usize) -> CreateSpec {
    CreateSpec { env: vec![(PRODUCE_ENV.into(), bytes.to_string())], ..spec(self_as_producer()) }
}

/// Collect a subscription until exit, acking as it goes.
async fn drain(sub: &mut nekko_term::Subscription, limit: Duration) -> (Vec<u8>, Option<Option<i32>>) {
    let mut out = sub.snapshot.clone();
    if let Some(code) = sub.exit {
        return (out, Some(code));
    }
    let deadline = Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, sub.rx.recv()).await {
            Ok(Some(StreamMsg::Data(b))) => {
                sub.ack(b.len());
                out.extend_from_slice(&b);
            }
            Ok(Some(StreamMsg::Exit(code))) => return (out, Some(code)),
            _ => return (out, None),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_output_and_reports_exit() {
    let reg = Registry::new();
    let info = reg.create(spec(echo("hello-nekko")));
    assert!(info.running);
    let mut sub = reg.subscribe(&info.id).expect("subscribes");
    let (out, exit) = drain(&mut sub, Duration::from_secs(20)).await;
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("hello-nekko"), "output was {text:?}");
    assert_eq!(exit, Some(Some(0)));
    let listed = reg.list();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].running);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_subscriber_gets_the_scrollback() {
    let reg = Registry::new();
    let info = reg.create(spec(echo("late-joiner")));
    let mut first = reg.subscribe(&info.id).unwrap();
    drain(&mut first, Duration::from_secs(20)).await;
    let late = reg.subscribe(&info.id).unwrap();
    assert!(String::from_utf8_lossy(&late.snapshot).contains("late-joiner"));
    assert!(late.exit.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_subscriber_that_does_not_ack_holds_the_program_back() {
    let reg = Registry::new();
    let total = 32 * 1024 * 1024;
    let info = reg.create(producing(total));
    let mut sub = reg.subscribe(&info.id).unwrap();

    // Wait for the first output: on Windows, ConPTY and the shell can take
    // longer to start than the window below, which then saw nothing.
    let mut received = match tokio::time::timeout(Duration::from_secs(30), sub.rx.recv()).await {
        Ok(Some(StreamMsg::Data(b))) => b.len(),
        other => panic!("no output from the producer: {:?}", other.map(|m| m.map(|_| "a message"))),
    };
    // Then read without acknowledging for well under the stall window.
    let until = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < until {
        match tokio::time::timeout(Duration::from_millis(50), sub.rx.recv()).await {
            Ok(Some(StreamMsg::Data(b))) => received += b.len(),
            Ok(Some(StreamMsg::Exit(_))) => panic!("producer finished without backpressure"),
            _ => {}
        }
    }
    // The pump may overshoot by one batch per recheck, never by the flood.
    assert!(received <= HIGH_WATER * 2, "received {received} unacked bytes");
    assert!(received > 0);

    // Acknowledge and the rest arrives.
    sub.ack(received);
    let (rest, exit) = drain(&mut sub, Duration::from_secs(60)).await;
    assert!(exit.is_some(), "producer never finished");
    assert!(received + rest.len() >= total, "got {} of {total}", received + rest.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_subscriber_stops_blocking_the_program() {
    let reg = Registry::new();
    let total = 8 * 1024 * 1024;
    let info = reg.create(producing(total));
    let _stuck = reg.subscribe(&info.id).unwrap();
    // Never ack. After the stall window the program must be allowed to finish.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if !reg.list().iter().any(|t| t.id == info.id && t.running) {
            break;
        }
        assert!(Instant::now() < deadline, "a stalled viewer froze the program");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_shell_reports_failure_instead_of_panicking() {
    let reg = Registry::new();
    let info = reg.create(spec(ShellOption {
        id: "nope".into(),
        label: "nope".into(),
        path: "/no/such/shell-for-nekko".into(),
        args: None,
    }));
    // Either spawn fails up front, or the child exits non-zero at once.
    let mut sub = reg.subscribe(&info.id).unwrap();
    let (_, exit) = drain(&mut sub, Duration::from_secs(10)).await;
    let code = exit.expect("reports an exit").unwrap_or(-1);
    assert_ne!(code, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_chat_a_terminal_was_opened_for_is_on_its_info() {
    let reg = Registry::new();
    let linked = reg.create(CreateSpec { session_id: Some("s_chat".into()), ..spec(echo("linked")) });
    let plain = reg.create(spec(echo("plain")));
    // An empty id is no link.
    let empty = reg.create(CreateSpec { session_id: Some(String::new()), ..spec(echo("empty")) });
    assert_eq!(linked.session_id.as_deref(), Some("s_chat"));
    assert_eq!(plain.session_id, None);
    assert_eq!(empty.session_id, None);
    let listed = reg.list();
    assert_eq!(listed.iter().find(|t| t.id == linked.id).unwrap().session_id.as_deref(), Some("s_chat"));
    assert_eq!(reg.snapshot(&linked.id).unwrap().info.session_id.as_deref(), Some("s_chat"));
    // On the wire: `sessionId` when linked, absent otherwise (older readers see no change).
    let json = serde_json::to_value(&linked).unwrap();
    assert_eq!(json["sessionId"], "s_chat");
    assert!(serde_json::to_value(&plain).unwrap().get("sessionId").is_none());
    assert!(json.get("viewers").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn viewers_attach_and_detach_with_an_event_each_time() {
    let reg = Registry::new();
    let mut events = reg.events();
    let a = reg.create(spec(echo("a")));
    let b = reg.create(spec(echo("b")));
    let phone = |name: &str| TerminalViewer::new("dev_1", "phone", Some(name.into()));

    let after = reg.attach_viewer(&a.id, phone("Philip's iPhone")).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].name.as_deref(), Some("Philip's iPhone"));
    assert!(after[0].since > 0);
    // Attaching again keeps one entry and takes the new name.
    let after = reg.attach_viewer(&a.id, phone("iPhone 17")).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].name.as_deref(), Some("iPhone 17"));
    reg.attach_viewer(&a.id, TerminalViewer::new("dev_2", "phone", None)).unwrap();
    reg.attach_viewer(&b.id, phone("iPhone 17")).unwrap();

    let info = reg.list().into_iter().find(|t| t.id == a.id).unwrap();
    assert_eq!(info.viewers.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["dev_1", "dev_2"]);
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["viewers"][0]["kind"], "phone");
    assert_eq!(json["viewers"][0]["name"], "iPhone 17");
    assert!(json["viewers"][1].get("name").is_none());

    assert_eq!(reg.detach_viewer(&a.id, "dev_2").unwrap().len(), 1);
    // Detaching a viewer that is not there changes nothing and sends nothing.
    assert_eq!(reg.detach_viewer(&a.id, "dev_2").unwrap().len(), 1);
    let mut left = reg.detach_viewer_everywhere("dev_1");
    left.sort();
    let mut both = vec![a.id.clone(), b.id.clone()];
    both.sort();
    assert_eq!(left, both);
    assert!(reg.list().iter().all(|t| t.viewers.is_empty()));
    assert!(reg.attach_viewer("term_missing", phone("x")).is_none());
    assert!(reg.detach_viewer("term_missing", "dev_1").is_none());

    // One `Viewers` event per change: 4 attaches, 1 detach, 2 from the sweep.
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while seen.len() < 7 && Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Ok(RegistryEvent::Viewers { id, viewers })) => seen.push((id, viewers.len())),
            Ok(Ok(_)) => {}
            _ => break,
        }
    }
    assert_eq!(seen.len(), 7, "{seen:?}");
    assert_eq!(seen[0], (a.id.clone(), 1));
    assert_eq!(seen[2], (a.id.clone(), 2));
    assert_eq!(seen[4], (a.id.clone(), 1));
    assert!(seen[5..].iter().all(|(_, n)| *n == 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tail_is_capped_and_starts_on_a_line() {
    let reg = Registry::new();
    let info = reg.create(producing(256 * 1024));
    let mut sub = reg.subscribe(&info.id).unwrap();
    drain(&mut sub, Duration::from_secs(30)).await;
    let full = reg.snapshot(&info.id).unwrap().buffer;
    assert!(full.len() > 200 * 1024, "produced {}", full.len());
    let (tail, total) = reg.tail(&info.id, 64 * 1024).unwrap();
    assert_eq!(total, full.len());
    assert!(tail.buffer.len() <= 64 * 1024);
    assert!(tail.buffer.len() > 60 * 1024, "{}", tail.buffer.len());
    assert!(full.ends_with(&tail.buffer));
    // The byte before the cut ends a line, so the replay starts on one.
    assert_eq!(full[full.len() - tail.buffer.len() - 1], b'\n');
    let (small, _) = reg.tail(&info.id, usize::MAX).unwrap();
    assert_eq!(small.buffer, full);
    assert!(reg.tail("term_missing", 10).is_none());
}

/// Keystroke-to-echo through the pty alone (no socket, no renderer): the
/// floor the terminal path sits on. Ignored by default; run with
/// `cargo test -p nekko-term --release -- --ignored --nocapture echo_latency`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn echo_latency_floor() {
    let shells: Vec<ShellOption> = nekko_term::detect_shells();
    for shell in shells {
        let reg = Registry::new();
        let info = reg.create(spec(shell.clone()));
        let mut sub = reg.subscribe(&info.id).unwrap();
        // Let the prompt settle.
        let settle = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < settle {
            if let Ok(Some(StreamMsg::Data(b))) = tokio::time::timeout(Duration::from_millis(100), sub.rx.recv()).await
            {
                sub.ack(b.len());
            }
        }
        let mut samples = Vec::new();
        for i in 0..40u8 {
            let ch = b'a' + (i % 26);
            let t = Instant::now();
            sub.handle.write(&[ch]);
            let deadline = t + Duration::from_millis(500);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(left, sub.rx.recv()).await {
                    Ok(Some(StreamMsg::Data(b))) => {
                        sub.ack(b.len());
                        if b.contains(&ch) {
                            samples.push(t.elapsed().as_secs_f64() * 1000.0);
                            break;
                        }
                    }
                    _ => break,
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        reg.write(&info.id, b"\x15");
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p = |q: f64| samples.get(((samples.len() as f64) * q) as usize).copied().unwrap_or(f64::NAN);
        println!("{:<20} n={:<3} p50={:>6.2}ms p95={:>6.2}ms", shell.label, samples.len(), p(0.5), p(0.95));
        reg.close(&info.id);
    }
}
