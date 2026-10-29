//! The signals judged: who is at the machine, and what argues against heavy
//! background work now. The platform reads themselves run on this machine in
//! `activity::tests`; here are the rules the automations will act on.

use nekko_machine::activity::{Activity, IDLE_AFTER_SECS, LOW_BATTERY_PCT, Power, Presence, Readings, Strain, assess};

fn away() -> Readings {
    Readings { idle_seconds: Some(IDLE_AFTER_SECS + 60.0), ..Readings::default() }
}

#[test]
fn a_headless_machine_is_idle() {
    // Docker, a server: no input to read, so background work may run. A chat
    // the user started is the only presence there.
    let a = assess(&Readings::default(), false, IDLE_AFTER_SECS);
    assert!(a.headless && !a.user_active);
    assert_eq!(assess(&Readings::default(), true, IDLE_AFTER_SECS).present, vec![Presence::Chat]);
}

#[test]
fn input_within_the_threshold_means_present() {
    for seconds in [0.0, IDLE_AFTER_SECS - 0.5] {
        assert!(
            assess(&Readings { idle_seconds: Some(seconds), ..Readings::default() }, false, IDLE_AFTER_SECS)
                .user_active
        );
    }
    assert!(!assess(&away(), false, IDLE_AFTER_SECS).user_active);
}

#[test]
fn a_chat_replying_is_presence_however_long_since_input() {
    // The user typed a prompt and stepped away: their machine is busy.
    let a = assess(&away(), true, IDLE_AFTER_SECS);
    assert!(a.user_active);
    assert_eq!(a.present, vec![Presence::Chat]);
}

#[test]
fn the_threshold_is_what_the_policy_sets() {
    // A machine idle for ten hours: idle at the default, present at a
    // threshold past that (an automation that never counts anyone as away).
    let r = Readings { idle_seconds: Some(36_000.0), ..Readings::default() };
    assert!(!assess(&r, false, IDLE_AFTER_SECS).user_active);
    assert!(assess(&r, false, 86_400.0).user_active);
    // The strictest threshold: only someone typing right now counts.
    let typing = Readings { idle_seconds: Some(0.2), ..Readings::default() };
    assert!(assess(&typing, false, 1.0).user_active);
    assert!(!assess(&typing, false, 0.1).user_active);
}

#[test]
fn battery_is_strain_and_a_low_one_says_so() {
    let on_battery = |percent: f64| Readings {
        idle_seconds: Some(9e9),
        power: Some(Power { on_battery: true, percent: Some(percent), low: percent <= LOW_BATTERY_PCT }),
        ..Readings::default()
    };
    let a = assess(&on_battery(60.0), false, IDLE_AFTER_SECS);
    assert_eq!(a.strain, vec![Strain::Battery]);
    assert!(!a.user_active, "on battery is not the user being here");
    let low = assess(&on_battery(LOW_BATTERY_PCT), false, IDLE_AFTER_SECS);
    assert_eq!(low.strain, vec![Strain::Battery, Strain::LowBattery]);
    let plugged = assess(
        &Readings { power: Some(Power { on_battery: false, percent: Some(4.0), low: true }), ..away() },
        false,
        IDLE_AFTER_SECS,
    );
    assert!(plugged.strain.is_empty(), "mains power, whatever the charge");
    assert!(assess(&away(), false, IDLE_AFTER_SECS).strain.is_empty(), "a desktop has no battery");
}

#[test]
fn heat_is_strain_whichever_chip_is_hot() {
    let hot_cpu = Readings { cpu_c: Some(100.0), ..away() };
    let hot_gpu = Readings { gpu_c: Some(90.0), ..away() };
    let warm = Readings { cpu_c: Some(99.0), gpu_c: Some(89.0), ..away() };
    for r in [hot_cpu, hot_gpu] {
        assert_eq!(assess(&r, false, IDLE_AFTER_SECS).strain, vec![Strain::Hot]);
    }
    assert!(assess(&warm, false, IDLE_AFTER_SECS).strain.is_empty());
}

#[test]
fn idle_seconds_are_reported_to_the_tenth() {
    let a = assess(&Readings { idle_seconds: Some(123.456), ..Readings::default() }, false, IDLE_AFTER_SECS);
    assert_eq!(a.idle_seconds, Some(123.5));
    assert_eq!(a.idle_after_seconds, IDLE_AFTER_SECS);
}

#[test]
fn the_answer_json_is_camel_case() {
    let a = Activity {
        user_active: true,
        present: vec![Presence::Input, Presence::Chat],
        strain: vec![Strain::Battery],
        idle_seconds: Some(3.0),
        headless: false,
        idle_after_seconds: 300.0,
        chat_active: true,
        power: Some(Power { on_battery: true, percent: Some(80.0), low: false }),
        cpu_c: Some(55.0),
        gpu_c: None,
    };
    let v = serde_json::to_value(a).unwrap();
    assert_eq!(v["present"], serde_json::json!(["input", "chat"]));
    assert_eq!(v["strain"], serde_json::json!(["battery"]));
    assert_eq!(v["power"]["onBattery"], serde_json::json!(true));
    assert_eq!(v["cpuC"], serde_json::json!(55.0));
    assert!(v.get("gpuC").is_none_or(|g| g.is_null()), "{v}");
}

/// What one look at the user's input costs when its cache has run out, as a
/// background reply's gate looks every 200 ms (B2), and a whole first reading
/// (temperatures and power too).
/// `cargo test -p nekko-machine --release --test activity -- --ignored --nocapture read_cost`
#[test]
#[ignore = "a measurement, not a check"]
fn read_cost() {
    use nekko_machine::activity::Sampler;
    use std::time::{Duration, Instant};
    let sampler = Sampler::default();
    let first = Instant::now();
    sampler.read();
    let first = first.elapsed();
    let mut input = Vec::new();
    for _ in 0..20 {
        // Past the input cache, inside the power and temperature ones.
        std::thread::sleep(Duration::from_millis(1100));
        let t = Instant::now();
        sampler.read();
        input.push(t.elapsed().as_secs_f64() * 1e6);
    }
    input.sort_by(f64::total_cmp);
    println!(
        "first reading {:.2} ms; input-only reading, median of 20: {:.1} µs (min {:.1}, max {:.1})",
        first.as_secs_f64() * 1000.0,
        input[10],
        input[0],
        input[19]
    );
}
