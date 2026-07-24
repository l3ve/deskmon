use serde::Serialize;

#[derive(Debug, Clone)]
struct ActiveCountdown {
    id: u64,
    minutes: u64,
    duration_seconds: u64,
    ends_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CountdownSnapshot {
    pub(crate) is_running: bool,
    pub(crate) minutes: Option<u64>,
    pub(crate) duration_seconds: u64,
    pub(crate) remaining_seconds: u64,
    pub(crate) ends_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub(crate) struct Countdown {
    active: Option<ActiveCountdown>,
    next_id: u64,
}

impl Countdown {
    pub(crate) fn active_id(&self) -> Option<u64> {
        self.active.as_ref().map(|countdown| countdown.id)
    }

    pub(crate) fn start(&mut self, minutes: u64, now_ms: u64) -> Option<u64> {
        if self.active.is_some() || minutes == 0 {
            return None;
        }
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let duration_seconds = minutes.saturating_mul(60);
        self.active = Some(ActiveCountdown {
            id: self.next_id,
            minutes,
            duration_seconds,
            ends_at_ms: now_ms.saturating_add(duration_seconds.saturating_mul(1000)),
        });
        Some(self.next_id)
    }

    pub(crate) fn cancel(&mut self) -> bool {
        self.active.take().is_some()
    }

    pub(crate) fn complete(&mut self, id: u64) -> Option<u64> {
        let active = self.active.as_ref()?;
        if active.id != id {
            return None;
        }
        self.active.take().map(|countdown| countdown.minutes)
    }

    pub(crate) fn snapshot(&self, now_ms: u64) -> CountdownSnapshot {
        let Some(active) = self.active.as_ref() else {
            return CountdownSnapshot {
                is_running: false,
                minutes: None,
                duration_seconds: 0,
                remaining_seconds: 0,
                ends_at_ms: None,
            };
        };
        let remaining_seconds = active.ends_at_ms.saturating_sub(now_ms).div_ceil(1000);
        CountdownSnapshot {
            is_running: remaining_seconds > 0,
            minutes: Some(active.minutes),
            duration_seconds: active.duration_seconds,
            remaining_seconds,
            ends_at_ms: Some(active.ends_at_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn countdown_starts_once_and_reports_remaining_time() {
        let mut countdown = Countdown::default();
        let id = countdown.start(30, 1_000).expect("countdown should start");

        assert_eq!(countdown.active_id(), Some(id));
        assert_eq!(
            countdown.snapshot(1_001),
            CountdownSnapshot {
                is_running: true,
                minutes: Some(30),
                duration_seconds: 1_800,
                remaining_seconds: 1_800,
                ends_at_ms: Some(1_801_000),
            }
        );
        assert_eq!(countdown.start(10, 2_000), None);
    }

    #[test]
    fn cancel_invalidates_the_active_worker() {
        let mut countdown = Countdown::default();
        let id = countdown.start(5, 0).expect("countdown should start");

        assert!(countdown.cancel());
        assert!(!countdown.cancel());
        assert_eq!(countdown.complete(id), None);
        assert!(!countdown.snapshot(1_000).is_running);
    }

    #[test]
    fn only_the_matching_worker_can_complete_the_countdown() {
        let mut countdown = Countdown::default();
        let first = countdown.start(5, 0).expect("countdown should start");
        assert!(countdown.cancel());
        let second = countdown
            .start(30, 1_000)
            .expect("countdown should restart");

        assert_eq!(countdown.complete(first), None);
        assert_eq!(countdown.active_id(), Some(second));
        assert_eq!(countdown.complete(second), Some(30));
        assert_eq!(countdown.active_id(), None);
    }

    #[test]
    fn elapsed_countdown_is_completed_by_the_worker_once() {
        let mut countdown = Countdown::default();
        let id = countdown.start(1, 500).expect("countdown should start");

        assert_eq!(countdown.snapshot(60_500).remaining_seconds, 0);
        assert_eq!(countdown.complete(id), Some(1));
        assert_eq!(countdown.complete(id), None);
    }
}
