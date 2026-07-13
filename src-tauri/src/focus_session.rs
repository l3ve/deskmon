use serde::{Deserialize, Serialize};

pub(crate) const EXTRA_SEGMENT_MINUTES: u64 = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TimerKind {
    Focus,
    Break,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FocusSessionPhase {
    #[default]
    Idle,
    FocusRunning,
    FocusComplete,
    BreakRunning,
    BreakComplete,
}

impl FocusSessionPhase {
    pub(crate) fn uses_central_presentation(self) -> bool {
        matches!(
            self,
            Self::FocusComplete | Self::BreakRunning | Self::BreakComplete
        )
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FocusSessionConfig {
    pub(crate) base_focus_minutes: u64,
    pub(crate) break_minutes: u64,
    pub(crate) focus_finished_message: String,
    pub(crate) break_finished_message: String,
    pub(crate) break_sound_enabled: bool,
}

#[derive(Debug, Clone)]
struct SessionContext {
    base_focus_minutes: u64,
    break_minutes: u64,
    focus_finished_message: String,
    break_finished_message: String,
    break_sound_enabled: bool,
}

impl From<FocusSessionConfig> for SessionContext {
    fn from(config: FocusSessionConfig) -> Self {
        Self {
            base_focus_minutes: config.base_focus_minutes,
            break_minutes: config.break_minutes,
            focus_finished_message: config.focus_finished_message,
            break_finished_message: config.break_finished_message,
            break_sound_enabled: config.break_sound_enabled,
        }
    }
}

#[derive(Debug, Clone)]
struct TimerSegment {
    id: u64,
    kind: TimerKind,
    duration_seconds: u64,
    ends_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusSessionSnapshot {
    pub(crate) phase: FocusSessionPhase,
    pub(crate) is_running: bool,
    pub(crate) kind: Option<TimerKind>,
    pub(crate) duration_seconds: u64,
    pub(crate) remaining_seconds: u64,
    pub(crate) ends_at_ms: Option<u64>,
    pub(crate) base_focus_minutes: Option<u64>,
    pub(crate) break_minutes: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct CompletionFeedback {
    pub(crate) kind: TimerKind,
    pub(crate) message: String,
    pub(crate) play_sound: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FocusSessionAction {
    CancelRound,
    StartBreak,
    ExtendFocus,
    FinishBreakEarly,
    ResumeFocus,
    ExtendBreak,
    EndRound,
}

#[derive(Debug, Default)]
pub(crate) struct FocusSession {
    phase: FocusSessionPhase,
    context: Option<SessionContext>,
    segment: Option<TimerSegment>,
    next_segment_id: u64,
}

impl FocusSession {
    pub(crate) fn phase(&self) -> FocusSessionPhase {
        self.phase
    }

    pub(crate) fn active_segment_id(&self) -> Option<u64> {
        self.segment.as_ref().map(|segment| segment.id)
    }

    pub(crate) fn start_round(&mut self, config: FocusSessionConfig, now_ms: u64) -> bool {
        if self.phase != FocusSessionPhase::Idle
            || config.base_focus_minutes == 0
            || config.break_minutes == 0
        {
            return false;
        }

        self.context = Some(config.into());
        self.start_segment(TimerKind::Focus, self.base_focus_minutes(), now_ms);
        self.phase = FocusSessionPhase::FocusRunning;
        true
    }

    pub(crate) fn apply_action(&mut self, action: FocusSessionAction, now_ms: u64) -> bool {
        match action {
            FocusSessionAction::CancelRound if self.phase == FocusSessionPhase::FocusRunning => {
                self.clear();
                true
            }
            FocusSessionAction::StartBreak if self.phase == FocusSessionPhase::FocusComplete => {
                self.start_segment(TimerKind::Break, self.break_minutes(), now_ms);
                self.phase = FocusSessionPhase::BreakRunning;
                true
            }
            FocusSessionAction::ExtendFocus if self.phase == FocusSessionPhase::FocusComplete => {
                self.start_segment(TimerKind::Focus, EXTRA_SEGMENT_MINUTES, now_ms);
                self.phase = FocusSessionPhase::FocusRunning;
                true
            }
            FocusSessionAction::FinishBreakEarly
                if self.phase == FocusSessionPhase::BreakRunning =>
            {
                self.segment = None;
                self.phase = FocusSessionPhase::BreakComplete;
                true
            }
            FocusSessionAction::ResumeFocus if self.phase == FocusSessionPhase::BreakComplete => {
                self.start_segment(TimerKind::Focus, self.base_focus_minutes(), now_ms);
                self.phase = FocusSessionPhase::FocusRunning;
                true
            }
            FocusSessionAction::ExtendBreak if self.phase == FocusSessionPhase::BreakComplete => {
                self.start_segment(TimerKind::Break, EXTRA_SEGMENT_MINUTES, now_ms);
                self.phase = FocusSessionPhase::BreakRunning;
                true
            }
            FocusSessionAction::EndRound if self.phase != FocusSessionPhase::Idle => {
                self.clear();
                true
            }
            _ => false,
        }
    }

    pub(crate) fn complete_segment(&mut self, segment_id: u64) -> Option<CompletionFeedback> {
        let segment = self.segment.as_ref()?;
        if segment.id != segment_id {
            return None;
        }

        let kind = segment.kind;
        let context = self.context.as_ref()?;
        let feedback = match kind {
            TimerKind::Focus => CompletionFeedback {
                kind,
                message: context.focus_finished_message.clone(),
                play_sound: false,
            },
            TimerKind::Break => CompletionFeedback {
                kind,
                message: context.break_finished_message.clone(),
                play_sound: context.break_sound_enabled,
            },
        };

        self.segment = None;
        self.phase = match kind {
            TimerKind::Focus => FocusSessionPhase::FocusComplete,
            TimerKind::Break => FocusSessionPhase::BreakComplete,
        };
        Some(feedback)
    }

    pub(crate) fn snapshot(&self, now_ms: u64) -> FocusSessionSnapshot {
        let remaining_seconds = self
            .segment
            .as_ref()
            .map(|segment| segment.ends_at_ms.saturating_sub(now_ms).div_ceil(1000))
            .unwrap_or(0);
        FocusSessionSnapshot {
            phase: self.phase,
            is_running: self.segment.is_some() && remaining_seconds > 0,
            kind: self.segment.as_ref().map(|segment| segment.kind),
            duration_seconds: self
                .segment
                .as_ref()
                .map(|segment| segment.duration_seconds)
                .unwrap_or(0),
            remaining_seconds,
            ends_at_ms: self.segment.as_ref().map(|segment| segment.ends_at_ms),
            base_focus_minutes: self
                .context
                .as_ref()
                .map(|context| context.base_focus_minutes),
            break_minutes: self.context.as_ref().map(|context| context.break_minutes),
        }
    }

    fn start_segment(&mut self, kind: TimerKind, minutes: u64, now_ms: u64) {
        self.next_segment_id = self.next_segment_id.wrapping_add(1).max(1);
        let duration_seconds = minutes.saturating_mul(60);
        self.segment = Some(TimerSegment {
            id: self.next_segment_id,
            kind,
            duration_seconds,
            ends_at_ms: now_ms.saturating_add(duration_seconds.saturating_mul(1000)),
        });
    }

    fn base_focus_minutes(&self) -> u64 {
        self.context
            .as_ref()
            .map(|context| context.base_focus_minutes)
            .unwrap_or(1)
    }

    fn break_minutes(&self) -> u64 {
        self.context
            .as_ref()
            .map(|context| context.break_minutes)
            .unwrap_or(1)
    }

    fn clear(&mut self) {
        self.phase = FocusSessionPhase::Idle;
        self.context = None;
        self.segment = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(base_focus_minutes: u64, break_minutes: u64) -> FocusSessionConfig {
        FocusSessionConfig {
            base_focus_minutes,
            break_minutes,
            focus_finished_message: "去休息".into(),
            break_finished_message: "回来继续".into(),
            break_sound_enabled: true,
        }
    }

    #[test]
    fn full_round_requires_explicit_transitions() {
        let mut session = FocusSession::default();
        assert!(session.start_round(config(25, 8), 1_000));
        let focus_id = session.active_segment_id().unwrap();
        assert_eq!(session.phase(), FocusSessionPhase::FocusRunning);

        let focus_feedback = session.complete_segment(focus_id).unwrap();
        assert_eq!(focus_feedback.kind, TimerKind::Focus);
        assert!(!focus_feedback.play_sound);
        assert_eq!(session.phase(), FocusSessionPhase::FocusComplete);

        assert!(session.apply_action(FocusSessionAction::StartBreak, 2_000));
        let break_snapshot = session.snapshot(2_000);
        assert_eq!(break_snapshot.phase, FocusSessionPhase::BreakRunning);
        assert_eq!(break_snapshot.duration_seconds, 8 * 60);

        let break_id = session.active_segment_id().unwrap();
        let break_feedback = session.complete_segment(break_id).unwrap();
        assert_eq!(break_feedback.kind, TimerKind::Break);
        assert!(break_feedback.play_sound);
        assert_eq!(session.phase(), FocusSessionPhase::BreakComplete);

        assert!(session.apply_action(FocusSessionAction::ResumeFocus, 3_000));
        let resumed = session.snapshot(3_000);
        assert_eq!(resumed.phase, FocusSessionPhase::FocusRunning);
        assert_eq!(resumed.duration_seconds, 25 * 60);
    }

    #[test]
    fn extensions_do_not_replace_round_durations() {
        let mut session = FocusSession::default();
        session.start_round(config(45, 12), 0);
        let focus_id = session.active_segment_id().unwrap();
        session.complete_segment(focus_id);

        assert!(session.apply_action(FocusSessionAction::ExtendFocus, 1_000));
        assert_eq!(session.snapshot(1_000).duration_seconds, 5 * 60);
        let extension_id = session.active_segment_id().unwrap();
        session.complete_segment(extension_id);

        session.apply_action(FocusSessionAction::StartBreak, 2_000);
        assert_eq!(session.snapshot(2_000).duration_seconds, 12 * 60);
        let break_id = session.active_segment_id().unwrap();
        session.complete_segment(break_id);

        assert!(session.apply_action(FocusSessionAction::ExtendBreak, 3_000));
        assert_eq!(session.snapshot(3_000).duration_seconds, 5 * 60);
        let extra_break_id = session.active_segment_id().unwrap();
        session.complete_segment(extra_break_id);

        session.apply_action(FocusSessionAction::ResumeFocus, 4_000);
        assert_eq!(session.snapshot(4_000).duration_seconds, 45 * 60);
    }

    #[test]
    fn early_break_completion_has_no_completion_feedback() {
        let mut session = FocusSession::default();
        session.start_round(config(25, 5), 0);
        let focus_id = session.active_segment_id().unwrap();
        session.complete_segment(focus_id);
        session.apply_action(FocusSessionAction::StartBreak, 1_000);

        assert!(session.apply_action(FocusSessionAction::FinishBreakEarly, 2_000));
        assert_eq!(session.phase(), FocusSessionPhase::BreakComplete);
        assert!(session.active_segment_id().is_none());
    }

    #[test]
    fn stale_worker_cannot_complete_a_new_segment() {
        let mut session = FocusSession::default();
        session.start_round(config(25, 5), 0);
        let first_id = session.active_segment_id().unwrap();
        session.complete_segment(first_id);
        session.apply_action(FocusSessionAction::ExtendFocus, 1_000);

        assert!(session.complete_segment(first_id).is_none());
        assert_eq!(session.phase(), FocusSessionPhase::FocusRunning);
    }

    #[test]
    fn invalid_actions_leave_the_state_unchanged() {
        let mut session = FocusSession::default();
        assert!(!session.apply_action(FocusSessionAction::StartBreak, 0));
        assert_eq!(session.phase(), FocusSessionPhase::Idle);

        session.start_round(config(25, 5), 0);
        assert!(!session.apply_action(FocusSessionAction::ResumeFocus, 1_000));
        assert_eq!(session.phase(), FocusSessionPhase::FocusRunning);
    }
}
