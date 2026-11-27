//! Calls to Nekko Cloud that several callers would otherwise repeat: a refresh
//! the account already has, and fetches that don't need to queue one by one.

use futures_util::{StreamExt, TryStreamExt};
use std::time::{Duration, Instant};

/// A refresh this recent, for the same sign-in, answers `cloud:refresh` without asking again
/// (Settings > Sync on every mount, sign-in, and Plan on every window focus all ask).
pub const REFRESH_WITHIN: Duration = Duration::from_secs(5);

/// When the account and sync state were last read, and under which token.
#[derive(Default)]
pub struct Refreshed(Option<(String, Instant)>);

impl Refreshed {
    pub fn mark(&mut self, token: &str, now: Instant) {
        self.0 = Some((token.to_string(), now));
    }

    /// True when a refresh under `token` finished less than `within` before `now`.
    pub fn is_fresh(&self, token: &str, now: Instant, within: Duration) -> bool {
        self.0.as_ref().is_some_and(|(t, at)| t == token && now.saturating_duration_since(*at) < within)
    }
}

/// Run `f` for each item, at most `limit` at a time; the first error stops the rest from starting.
pub async fn for_each_bounded<T, F, Fut>(items: Vec<T>, limit: usize, f: F) -> Result<(), String>
where
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    futures_util::stream::iter(items).map(Ok).try_for_each_concurrent(limit, f).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_refresh_is_fresh_for_five_seconds_and_only_for_its_own_token() {
        let t0 = Instant::now();
        let mut r = Refreshed::default();
        assert!(!r.is_fresh("a", t0, REFRESH_WITHIN), "never refreshed");
        r.mark("a", t0);
        assert!(r.is_fresh("a", t0 + Duration::from_secs(4), REFRESH_WITHIN));
        assert!(!r.is_fresh("a", t0 + Duration::from_secs(5), REFRESH_WITHIN));
        assert!(!r.is_fresh("b", t0, REFRESH_WITHIN), "another sign-in");
    }

    #[tokio::test]
    async fn fetches_overlap_up_to_the_limit_and_no_more() {
        let (now, peak, done) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
        for_each_bounded((0..10).collect(), 3, |_| async {
            let n = now.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(15)).await;
            now.fetch_sub(1, Ordering::SeqCst);
            done.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!((peak.load(Ordering::SeqCst), done.load(Ordering::SeqCst)), (3, 10));
    }

    #[tokio::test]
    async fn the_first_failure_is_returned_and_stops_new_fetches() {
        let started = AtomicUsize::new(0);
        let result = for_each_bounded((0..20).collect(), 3, |i: usize| {
            started.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if i == 1 { Err("no".to_string()) } else { Ok(()) }
            }
        })
        .await;
        assert_eq!(result, Err("no".to_string()));
        assert!(started.load(Ordering::SeqCst) < 20);
    }
}
