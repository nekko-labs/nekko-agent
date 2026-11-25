//! When the daemon's periodic Nekko Cloud work runs, spread out so a fleet of
//! computers that started, stalled or were nudged together doesn't come back
//! together: timer jitter, redial backoff, nudge coalescing and Relay ticket
//! reuse. Every function takes its random number in, so the schedules are
//! tested without clocks or sleeps.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// A random number in `[0, 1)`.
pub fn unit() -> f64 {
    u32::from_le_bytes(crate::http::nekko_sync_random::<4>()) as f64 / (u32::MAX as f64 + 1.0)
}

/// `base` made 20% shorter to 20% longer, so repeating timers drift apart.
pub fn jittered(base: Duration, unit: f64) -> Duration {
    base.mul_f64(0.8 + 0.4 * unit)
}

/// How long a repeating timer waits before its first run: up to a quarter of its interval.
pub fn start_offset(interval: Duration, unit: f64) -> Duration {
    interval.mul_f64(0.25 * unit)
}

const REDIAL_FIRST: Duration = Duration::from_secs(5);
const REDIAL_LAST: Duration = Duration::from_secs(300);

/// The wait before dialling the Relay again after `failures` sessions in a row that didn't hold:
/// 5 s, 10 s, 20 s... up to 5 min, each 20% shorter to 20% longer (never under 5 s, never over 5 min).
pub fn redial_wait(failures: u32, unit: f64) -> Duration {
    let doubled = REDIAL_FIRST.saturating_mul(1u32.checked_shl(failures.min(16)).unwrap_or(u32::MAX));
    jittered(doubled.min(REDIAL_LAST), unit).clamp(REDIAL_FIRST, REDIAL_LAST)
}

/// A session this long counts as the Relay being fine: the next redial starts from 5 s again.
pub const STABLE_SESSION: Duration = Duration::from_secs(60);

/// The most a nudge-triggered pass is held, so the account's devices don't all pull the instant one pushes.
pub const NUDGE_WINDOW: Duration = Duration::from_secs(3);

/// How long to hold a nudge-triggered pass: 0 to `window`.
pub fn nudge_delay(window: Duration, unit: f64) -> Duration {
    window.mul_f64(unit)
}

/// With the Relay account channel up, a change arrives as a nudge, so the timer is only a safety net.
pub const SAFETY_POLL: Duration = Duration::from_secs(5 * 60);

/// The account and sync state are read in full at least this often (and on events), not on every pass.
pub const FULL_EVERY: Duration = Duration::from_secs(10 * 60);

/// How often the sync loop looks at the clock to notice the computer waking from sleep.
pub const WAKE_TICK: Duration = Duration::from_secs(30);

/// How long the sync loop waits between passes: `every` without the channel, the safety poll with it.
pub fn poll_interval(channel_up: bool, every: Duration) -> Duration {
    if channel_up { SAFETY_POLL.max(every) } else { every }
}

/// Spots a computer waking from sleep: the wall clock jumped further than the loop's own tick.
/// Timers count awake time only, so after a lid-close a 5 min wait would otherwise run on.
pub struct WakeWatch {
    last: std::time::SystemTime,
}

impl WakeWatch {
    pub fn new(now: std::time::SystemTime) -> Self {
        WakeWatch { last: now }
    }

    /// Called every `WAKE_TICK`; true when far more wall time passed than that.
    pub fn woke(&mut self, now: std::time::SystemTime) -> bool {
        let gap = now.duration_since(self.last).unwrap_or(Duration::ZERO);
        self.last = now;
        gap > WAKE_TICK * 2
    }
}

/// When the account and sync state were last read in full, and whether something asked for another read.
#[derive(Default)]
pub struct FullRead {
    last: Option<(String, Instant)>,
    wanted: bool,
}

impl FullRead {
    pub fn done(&mut self, token: &str, now: Instant) {
        self.last = Some((token.to_string(), now));
        self.wanted = false;
    }

    /// Something said the account or its settings changed: read in full on the next pass.
    pub fn want(&mut self) {
        self.wanted = true;
    }

    /// A full read is due: never done under this token, asked for, or `FULL_EVERY` old.
    pub fn due(&self, token: &str, now: Instant) -> bool {
        self.wanted
            || self.last.as_ref().is_none_or(|(t, at)| t != token || now.saturating_duration_since(*at) >= FULL_EVERY)
    }
}

/// One pass at a time is waiting on a nudge; nudges that arrive meanwhile join it.
#[derive(Default)]
pub struct Pending(AtomicBool);

impl Pending {
    /// True for the caller that should schedule the pass; false when one is already waiting.
    pub fn begin(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    /// The waiting pass is starting: later nudges schedule the next one.
    pub fn end(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Relay tickets kept until they should be renewed (`renewAfterSeconds`), per scope and room,
/// and per Nekko Cloud token so a sign-in as someone else never reuses them.
#[derive(Default)]
pub struct Tickets(Mutex<BTreeMap<(String, String), Held>>);

struct Held {
    token: String,
    ticket: String,
    renew_at: Instant,
}

/// A held ticket this close to renewal is asked for again, so a caller never gets one about to lapse.
const MARGIN: Duration = Duration::from_secs(5);

impl Tickets {
    fn key(scope: &str, room: Option<&str>) -> (String, String) {
        (scope.to_string(), room.unwrap_or("").to_string())
    }

    /// The ticket still good at `now`, and how long until it should be renewed.
    pub fn get(&self, token: &str, scope: &str, room: Option<&str>, now: Instant) -> Option<(String, Duration)> {
        let held = crate::lock(&self.0);
        let h = held.get(&Self::key(scope, room))?;
        let left = h.renew_at.checked_duration_since(now)?;
        (h.token == token && left > MARGIN).then(|| (h.ticket.clone(), left))
    }

    pub fn put(&self, token: &str, scope: &str, room: Option<&str>, ticket: &str, renew: Duration, now: Instant) {
        crate::lock(&self.0).insert(
            Self::key(scope, room),
            Held { token: token.to_string(), ticket: ticket.to_string(), renew_at: now + renew },
        );
    }

    /// The Relay refused a ticket (or we signed out): ask for a new one next time.
    pub fn forget(&self, scope: &str, room: Option<&str>) {
        crate::lock(&self.0).remove(&Self::key(scope, room));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(d: Duration) -> f64 {
        d.as_secs_f64()
    }

    #[test]
    fn timers_drift_by_a_fifth_either_way() {
        let base = Duration::from_secs(60);
        assert_eq!(secs(jittered(base, 0.0)), 48.0);
        assert_eq!(secs(jittered(base, 0.5)), 60.0);
        assert!((secs(jittered(base, 0.999_999)) - 72.0).abs() < 0.001);
        assert!((0.0..1.0).contains(&unit()));
    }

    #[test]
    fn the_first_run_waits_up_to_a_quarter_of_the_interval() {
        assert_eq!(secs(start_offset(Duration::from_secs(60), 0.0)), 0.0);
        assert_eq!(secs(start_offset(Duration::from_secs(60), 0.8)), 12.0);
        assert!(secs(start_offset(Duration::from_secs(30), 0.999_999)) < 7.5);
    }

    #[test]
    fn redial_backs_off_from_five_seconds_to_five_minutes() {
        let at = |n| secs(redial_wait(n, 0.5));
        assert_eq!([at(0), at(1), at(2), at(3), at(4), at(5), at(6)], [5.0, 10.0, 20.0, 40.0, 80.0, 160.0, 300.0]);
        assert_eq!(at(7), 300.0);
        assert_eq!(at(10_000), 300.0, "no overflow");
    }

    #[test]
    fn redial_jitter_never_goes_under_five_seconds_or_over_five_minutes() {
        assert_eq!(secs(redial_wait(0, 0.0)), 5.0);
        assert_eq!(secs(redial_wait(1, 0.0)), 8.0);
        assert_eq!(secs(redial_wait(1, 0.999_999)).round(), 12.0);
        assert_eq!(secs(redial_wait(6, 0.999_999)), 300.0);
        assert_eq!(secs(redial_wait(6, 0.0)), 240.0);
    }

    #[test]
    fn nudges_are_held_for_up_to_three_seconds() {
        assert_eq!(secs(nudge_delay(NUDGE_WINDOW, 0.0)), 0.0);
        assert_eq!(secs(nudge_delay(NUDGE_WINDOW, 0.5)), 1.5);
        assert!(secs(nudge_delay(NUDGE_WINDOW, 0.999_999)) < 3.0);
    }

    #[test]
    fn the_timer_slows_to_a_safety_poll_only_while_the_channel_is_up() {
        let every = Duration::from_secs(60);
        assert_eq!(poll_interval(false, every), every);
        assert_eq!(poll_interval(true, every), Duration::from_secs(300));
        assert_eq!(poll_interval(true, Duration::from_secs(900)), Duration::from_secs(900), "never faster than asked");
    }

    #[test]
    fn a_wall_clock_jump_means_the_computer_slept() {
        use std::time::SystemTime;
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let mut w = WakeWatch::new(t0);
        assert!(!w.woke(t0 + WAKE_TICK), "an ordinary tick");
        assert!(!w.woke(t0 + WAKE_TICK * 2 + Duration::from_secs(5)), "a little late");
        assert!(w.woke(t0 + Duration::from_secs(3600)), "an hour passed in one tick");
        assert!(!w.woke(t0 + Duration::from_secs(3630)), "and back to normal");
        assert!(!w.woke(t0), "a clock set back is not a wake");
    }

    #[test]
    fn a_full_read_is_due_on_start_on_a_new_token_when_asked_and_every_ten_minutes() {
        let t0 = Instant::now();
        let mut f = FullRead::default();
        assert!(f.due("a", t0), "on start");
        f.done("a", t0);
        assert!(!f.due("a", t0 + Duration::from_secs(599)));
        assert!(f.due("a", t0 + Duration::from_secs(600)), "ten minutes");
        assert!(f.due("b", t0), "another sign-in");
        f.want();
        assert!(f.due("a", t0), "asked for");
        f.done("a", t0 + Duration::from_secs(1));
        assert!(!f.due("a", t0 + Duration::from_secs(2)), "asking is cleared by a read");
    }

    #[test]
    fn a_burst_of_nudges_schedules_one_pass() {
        let p = Pending::default();
        let scheduled = (0..10).filter(|_| p.begin()).count();
        assert_eq!(scheduled, 1);
        p.end();
        assert!(p.begin(), "the next nudge after the pass started schedules another");
    }

    #[test]
    fn a_ticket_is_reused_until_it_is_due_for_renewal() {
        let t = Tickets::default();
        let t0 = Instant::now();
        assert!(t.get("tok", "account", None, t0).is_none());
        t.put("tok", "account", None, "nkr1.a", Duration::from_secs(3600), t0);
        let (ticket, left) = t.get("tok", "account", None, t0 + Duration::from_secs(600)).unwrap();
        assert_eq!((ticket.as_str(), secs(left)), ("nkr1.a", 3000.0));
        assert!(t.get("tok", "account", None, t0 + Duration::from_secs(3599)).is_none(), "about to lapse");
        assert!(t.get("tok", "account", None, t0 + Duration::from_secs(4000)).is_none(), "past renewal");
    }

    #[test]
    fn tickets_are_per_scope_room_and_token_and_can_be_forgotten() {
        let t = Tickets::default();
        let t0 = Instant::now();
        t.put("tok", "agent", Some("room-1"), "nkr1.r1", Duration::from_secs(3600), t0);
        assert!(t.get("tok", "agent", Some("room-2"), t0).is_none());
        assert!(t.get("tok", "account", None, t0).is_none());
        assert!(t.get("other", "agent", Some("room-1"), t0).is_none(), "another sign-in");
        assert!(t.get("tok", "agent", Some("room-1"), t0).is_some());
        t.forget("agent", Some("room-1"));
        assert!(t.get("tok", "agent", Some("room-1"), t0).is_none());
    }
}
