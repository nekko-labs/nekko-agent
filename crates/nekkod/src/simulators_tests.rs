use super::*;

fn ios(id: &str, name: &str, up_secs: u64) -> Device {
    Device {
        id: id.into(),
        kind: Kind::Ios,
        name: name.into(),
        model: None,
        os: None,
        cpu_pct: 1.0,
        up_secs,
        processes: 300,
        serial: None,
        pid: 1,
    }
}

const IPAD: &str = "A205885C-E689-4FCE-93EE-E39B21CC52F8";
const PHONE: &str = "937C0078-69EC-4BEF-8C34-710DA0A4F98F";

fn recent(session: &str, at: u64, text: &str) -> Recent {
    Recent { session_id: session.into(), call_id: format!("c{at}"), at, text: text.into() }
}

#[test]
fn acting_commands_are_told_from_listing_and_stopping() {
    assert!(acts_on_simulator("xcrun simctl boot A205885C-E689-4FCE-93EE-E39B21CC52F8"));
    assert!(acts_on_simulator("xcrun simctl install booted build/App.app && xcrun simctl launch booted com.x"));
    assert!(acts_on_simulator(
        "xcodebuild -project NekkoNative.xcodeproj -scheme NekkoNative -destination 'platform=iOS Simulator,id=X' test"
    ));
    assert!(acts_on_simulator("adb -s emulator-5594 install app.apk"));
    assert!(acts_on_simulator("$ANDROID_HOME/emulator/emulator -avd agent2649_api36 -no-window"));
    assert!(acts_on_simulator("node scripts/ios-evidence-local.mjs --preset mode"));
    assert!(!acts_on_simulator("xcrun simctl list devices booted"));
    assert!(!acts_on_simulator("xcrun simctl shutdown all"));
    assert!(!acts_on_simulator("adb -s emulator-5594 emu kill"));
    assert!(!acts_on_simulator("adb devices"));
    assert!(!acts_on_simulator("ps -Ao pid,command | grep launchd_sim"));
    assert!(!acts_on_simulator("cargo test -p nekkod"));
}

#[test]
fn names_need_a_whole_word() {
    let d = ios(PHONE, "Nekko-1882", 60);
    assert!(mentions("xcrun simctl boot 937c0078-69ec-4bef-8c34-710da0a4f98f", &d));
    assert!(mentions("-destination 'platform=iOS Simulator,name=Nekko-1882'", &d));
    assert!(!mentions("-destination 'platform=iOS Simulator,name=Nekko-18820'", &d));
    assert!(!mentions("-destination 'platform=iOS Simulator,name=Nekko-1882-iPad'", &d));
}

#[test]
fn a_named_device_is_the_chat_that_named_it() {
    let devices = vec![ios(IPAD, "Nekko-1314-iPad", 600), ios(PHONE, "Nekko-1882", 9 * 86_400)];
    let before: HashSet<String> = devices.iter().map(|d| d.id.clone()).collect();
    let mut log = VecDeque::new();
    log.push_back(recent("chat-a", 1_000, &format!("xcodebuild -destination 'platform=iOS Simulator,id={IPAD}' test")));
    let mut uses = HashMap::new();
    let fresh = attribute(&devices, &before, &log, &mut uses, 2_000);
    assert_eq!(fresh.len(), 1);
    assert_eq!(uses[IPAD], Use { session_id: "chat-a".into(), at: 1_000 });
    assert!(!uses.contains_key(PHONE));
    // Seen again: nothing new.
    assert!(attribute(&devices, &before, &log, &mut uses, 3_000).is_empty());
    // Another chat takes it over.
    log.push_back(recent("chat-b", 5_000, &format!("xcrun simctl launch {IPAD} com.nekko")));
    let fresh = attribute(&devices, &before, &log, &mut uses, 6_000);
    assert_eq!(fresh[0].1.session_id, "chat-b");
}

#[test]
fn a_device_that_boots_after_an_unnamed_call_is_that_calls() {
    let now = 10 * 60_000;
    // Booted 30 s ago, after a script that made its own simulator ran 50 s ago.
    let devices = vec![ios(IPAD, "Evidence-before", 30)];
    let mut log = VecDeque::new();
    log.push_back(recent("chat-a", now - 50_000, "node scripts/ios-evidence-local.mjs --preset mode"));
    let mut uses = HashMap::new();
    let fresh = attribute(&devices, &HashSet::new(), &log, &mut uses, now);
    assert_eq!(fresh.len(), 1);
    assert_eq!(uses[IPAD].session_id, "chat-a");
    // A device already up before the call is not.
    let mut uses = HashMap::new();
    let old = vec![ios(IPAD, "Evidence-before", 600)];
    assert!(attribute(&old, &HashSet::new(), &log, &mut uses, now).is_empty());
    // Nor one booted at the last look.
    let before: HashSet<String> = [IPAD.to_string()].into();
    assert!(attribute(&devices, &before, &log, &mut uses, now).is_empty());
}

#[test]
fn booted_means_the_newest_ios_device() {
    let devices = vec![ios(IPAD, "a-device", 100), ios(PHONE, "b-device", 5_000)];
    let before: HashSet<String> = devices.iter().map(|d| d.id.clone()).collect();
    let mut log = VecDeque::new();
    log.push_back(recent("chat-a", 1_000, "xcrun simctl install booted App.app"));
    let mut uses = HashMap::new();
    attribute(&devices, &before, &log, &mut uses, 2_000);
    assert_eq!(uses.get(IPAD).map(|u| u.session_id.as_str()), Some("chat-a"));
    assert!(!uses.contains_key(PHONE));
}

#[tokio::test]
async fn a_call_on_a_known_device_is_attributed_at_once_and_its_output_kept() {
    let reg = Arc::new(Simulators::bare());
    lock(&reg.state).devices = vec![ios(IPAD, "Nekko-1314-iPad", 600)];
    reg.observe(
        "chat-a",
        &json!({ "type": "tool_call", "call": { "id": "t1", "name": "Bash", "input": { "command": format!("xcrun simctl launch {IPAD} com.x") } } }),
    );
    assert_eq!(lock(&reg.state).uses[IPAD].session_id, "chat-a");
    // Not acting: ignored.
    reg.observe(
        "chat-b",
        &json!({ "type": "tool_call", "call": { "id": "t2", "name": "Bash", "input": { "command": "xcrun simctl list" } } }),
    );
    assert_eq!(lock(&reg.state).recent.len(), 1);
    // The result of the acting call joins its text.
    reg.observe(
        "chat-a",
        &json!({ "type": "tool_result", "result": { "toolCallId": "t1", "output": "NEW-UDID-HERE" } }),
    );
    assert!(lock(&reg.state).recent[0].text.contains("NEW-UDID-HERE"));
}
