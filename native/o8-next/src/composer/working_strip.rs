//! The working strip: while a turn runs, a 40px Glance, one status line and
//! the turn's timer sit directly above the composer (docs/design/BRAND.md §7).
//! It floats over the transcript's foot instead of taking a row of its own, so
//! the transcript never moves when it appears or leaves.
use super::*;
use crate::glance::{self, Face};
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

/// The strip's height: the 40px Glance and nothing more.
pub(crate) const STRIP_HEIGHT: f32 = 40.;
const GLANCE_PX: f32 = 40.;

/// What the transcript already says about the running turn.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Signals {
    /// The turn's last block is live (`Trace.live`).
    pub live: bool,
    /// That block has reasoning (`Trace.thinking`).
    pub thinking: bool,
    /// Its tool steps still running.
    pub running: usize,
}

/// What the strip shows. Only the states with a signal today; the rest of
/// BRAND.md §7 lands as their signals do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkingState {
    /// Reasoning, or between steps: Glance's resting loop.
    Thinking,
    /// Tool steps run, or the live block has no reasoning (the trace's
    /// "Working" header).
    TakingIn { running: usize },
}

pub(crate) fn working_state(signals: Signals) -> WorkingState {
    if signals.live && (signals.running > 0 || !signals.thinking) {
        WorkingState::TakingIn {
            running: signals.running,
        }
    } else {
        WorkingState::Thinking
    }
}

impl WorkingState {
    /// The status line, from real counts only.
    pub(crate) fn line(self) -> String {
        match self {
            Self::Thinking => "Thinking about what changed".into(),
            Self::TakingIn { running: 0 } => "Taking in the work".into(),
            Self::TakingIn { running: 1 } => "Taking in the work · 1 step running".into(),
            Self::TakingIn { running } => format!("Taking in the work · {running} steps running"),
        }
    }

    /// The pose `phase` (0..1) through this state's loop. Both Phase A states
    /// use the Thinking motion for now.
    fn pose(self, rest: &Face, phase: f32) -> Face {
        match self {
            Self::Thinking | Self::TakingIn { .. } => glance::thinking(rest, phase),
        }
    }
}

/// `m:ss · esc to stop`.
pub(crate) fn timer(elapsed_ms: f64) -> String {
    let secs = (elapsed_ms / 1000.).max(0.) as u64;
    format!("{}:{:02} · esc to stop", secs / 60, secs % 60)
}

/// The last block of the transcript's running turn, as signals and its start
/// (epoch ms) when known.
fn signals(rows: &[Rc<RefCell<crate::retained::RowState>>]) -> (Signals, Option<f64>) {
    rows.iter()
        .rev()
        .find_map(|row| match &row.borrow().row {
            crate::model::Row::Activity { steps, trace, .. } => Some((
                Signals {
                    live: trace.live,
                    thinking: trace.thinking,
                    running: if trace.live {
                        steps.iter().filter(|s| s.status == "running").count()
                    } else {
                        0
                    },
                },
                trace.turn_started.or(trace.started),
            )),
            _ => None,
        })
        .map_or((Signals::default(), None), |(signals, start)| {
            (signals, if signals.live { start } else { None })
        })
}

/// A showing strip: when it appeared, its state, and the pose on screen when
/// that state began, so a change eases from there.
struct Glide {
    shown: Instant,
    state: WorkingState,
    since: Instant,
    from: Face,
    last: Face,
}

thread_local! {
    /// Each chat's showing strip; it leaves with the turn.
    static GLIDES: RefCell<HashMap<String, Glide>> = RefCell::default();
}

/// The pose to draw now, the state's loop eased in from the previous pose over
/// [`glance::GLIDE_SECS`] after a change, and when the strip appeared.
fn pose(key: &str, state: WorkingState, rest: &Face, phase: f32, still: bool) -> (Face, Instant) {
    let target = if still {
        *rest
    } else {
        state.pose(rest, phase)
    };
    GLIDES.with(|glides| {
        let mut glides = glides.borrow_mut();
        let now = Instant::now();
        let glide = glides.entry(key.to_owned()).or_insert(Glide {
            shown: now,
            state,
            since: now,
            from: target,
            last: target,
        });
        if glide.state != state {
            glide.state = state;
            glide.since = now;
            glide.from = glide.last;
        }
        let face = glance::glide(&glide.from, &target, glide.since.elapsed().as_secs_f32());
        glide.last = face;
        (face, glide.shown)
    })
}

impl Surface {
    pub(super) fn working_strip_shown(&self) -> bool {
        self.turn_running() && self.empty_chat_project().is_none()
    }

    /// The strip, or nothing when no turn runs.
    pub(super) fn working_strip(&self) -> Option<gpui::AnyElement> {
        let key = self.selected.clone().unwrap_or_default();
        if !self.working_strip_shown() {
            GLIDES.with(|glides| glides.borrow_mut().remove(&key));
            return None;
        }
        let (signals, started) = signals(&self.rows);
        let state = working_state(signals);
        // The trace header's shared clock, so the face and the shimmer agree.
        let beat = crate::trace::seen("trace:clock", true)
            .elapsed()
            .as_secs_f32();
        let still = glance::reduced_motion();
        let rest = Face::resting(!crate::theme::light());
        let phase = (beat % glance::THINKING_LOOP) / glance::THINKING_LOOP;
        let (face, shown) = pose(&key, state, &rest, phase, still);
        // A turn whose block has no start yet times from the strip's first frame.
        let elapsed = match started {
            Some(start) => crate::trace::now_ms() - start,
            None => shown.elapsed().as_secs_f64() * 1000.,
        };
        Some(
            div()
                .relative()
                .w_full()
                .h(px(0.))
                .child(
                    div()
                        .debug_selector(|| "composer-working-strip".into())
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom_0()
                        .h(px(STRIP_HEIGHT))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(6.))
                        .bg(theme().background)
                        .child(glance::glance(face, GLANCE_PX))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_size(px(13.))
                                .text_color(theme().text_secondary)
                                .child(state.line()),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_family(theme().font_mono)
                                .text_size(px(11.5))
                                .text_color(theme().text_faint)
                                .child(timer(elapsed)),
                        )
                        // The face moves and the timer counts: redraw each
                        // frame while the strip shows, and only then.
                        .child(
                            canvas(
                                |_, window, _| window.request_animation_frame(),
                                |_, _, _, _| {},
                            )
                            .size_0(),
                        ),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_is_thinking() {
        let signals = Signals {
            live: true,
            thinking: true,
            running: 0,
        };
        assert_eq!(working_state(signals), WorkingState::Thinking);
        assert_eq!(working_state(signals).line(), "Thinking about what changed");
    }

    #[test]
    fn running_steps_are_taking_in_with_their_count() {
        let state = working_state(Signals {
            live: true,
            thinking: true,
            running: 3,
        });
        assert_eq!(state, WorkingState::TakingIn { running: 3 });
        assert_eq!(state.line(), "Taking in the work · 3 steps running");
        let one = working_state(Signals {
            live: true,
            thinking: false,
            running: 1,
        });
        assert_eq!(one.line(), "Taking in the work · 1 step running");
    }

    #[test]
    fn a_live_block_without_reasoning_is_taking_in_without_a_number() {
        // The trace's "Working" header: live, no reasoning, nothing running yet.
        let state = working_state(Signals {
            live: true,
            thinking: false,
            running: 0,
        });
        assert_eq!(state, WorkingState::TakingIn { running: 0 });
        assert_eq!(state.line(), "Taking in the work");
    }

    #[test]
    fn no_live_block_rests_on_thinking() {
        assert_eq!(working_state(Signals::default()), WorkingState::Thinking);
    }

    #[test]
    fn timer_reads_minutes_and_seconds() {
        assert_eq!(timer(0.), "0:00 · esc to stop");
        assert_eq!(timer(65_400.), "1:05 · esc to stop");
        assert_eq!(timer(-20.), "0:00 · esc to stop");
    }

    #[test]
    fn a_state_change_eases_from_the_pose_on_screen() {
        let rest = Face::resting(false);
        let key = "glide-test";
        let (first, _) = pose(key, WorkingState::Thinking, &rest, 0.5, false);
        assert!((first.look + 0.7).abs() < 1e-3);
        // The state changes mid-loop: the next frame starts where the face was.
        let (next, _) = pose(
            key,
            WorkingState::TakingIn { running: 1 },
            &rest,
            0.0,
            false,
        );
        assert!(next.look < 0., "eases, does not jump: {}", next.look);
        // Reduced motion holds the resting pose.
        GLIDES.with(|g| g.borrow_mut().clear());
        assert_eq!(pose(key, WorkingState::Thinking, &rest, 0.5, true).0, rest);
    }
}
