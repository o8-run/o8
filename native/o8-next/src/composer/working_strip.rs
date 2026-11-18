//! The working strip: while a turn runs, one status line and the turn's timer
//! sit directly above the composer.
//! It floats over the transcript's foot instead of taking a row of its own, so
//! the transcript never moves when it appears or leaves.
use super::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

/// One text line with a little vertical breathing room; also lifts the changes pill.
pub(crate) const STRIP_HEIGHT: f32 = 24.;

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
    /// Reasoning, or between steps.
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

thread_local! {
    /// First appearance of each chat's strip, only for the timer's missing-start fallback.
    static SHOWN_AT: RefCell<HashMap<String, Instant>> = RefCell::default();
}

impl Surface {
    pub(super) fn working_strip_shown(&self) -> bool {
        self.turn_running() && self.empty_chat_project().is_none()
    }

    /// The strip, or nothing when no turn runs.
    pub(super) fn working_strip(&self) -> Option<gpui::AnyElement> {
        let key = self.selected.clone().unwrap_or_default();
        if !self.working_strip_shown() {
            SHOWN_AT.with(|shown| shown.borrow_mut().remove(&key));
            return None;
        }
        let (signals, started) = signals(&self.rows);
        let state = working_state(signals);
        let shown =
            SHOWN_AT.with(|shown| *shown.borrow_mut().entry(key).or_insert_with(Instant::now));
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
                        .child(
                            div()
                                .debug_selector(|| "composer-working-status".into())
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
                        // Keep the elapsed timer updating while the strip shows.
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

    #[gpui::test]
    fn running_agent_status_has_no_inline_face_or_reserved_face_gap(cx: &mut gpui::TestAppContext) {
        let client = Client::authenticated("http://127.0.0.1:9", None).unwrap();
        let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
        surface.update(cx, |s, cx| {
            s.selected = Some("thoughts-working-strip".into());
            let mut transcript = crate::stream::Transcript::new(
                serde_json::from_value(serde_json::json!({
                    "sessionKey":"llm-chat:thoughts-working-strip", "transcript":[]
                }))
                .unwrap(),
            );
            transcript.apply(
                &serde_json::json!({"channel":"orchestrator", "event":"status",
                "data":{"threadId":"thoughts-working-strip", "status":"busy", "snapshot":true}}),
            );
            let rows = transcript.rows.clone();
            s.transcript = Some(transcript);
            s.install_rows(rows, cx);
            assert!(s.working_strip_shown());
            cx.notify();
        });
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        let strip = cx
            .debug_bounds("composer-working-strip")
            .expect("running strip rendered");
        assert_eq!(strip.size.height, px(24.), "no reserved 40px face row");
        let status = cx
            .debug_bounds("composer-working-status")
            .expect("status line rendered");
        assert_eq!(
            status.left() - strip.left(),
            px(6.),
            "text starts at strip padding, without a face slot"
        );
        assert!(status.size.width > px(0.));
        assert!(status.top() >= strip.top() && status.bottom() <= strip.bottom());
    }

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
}
