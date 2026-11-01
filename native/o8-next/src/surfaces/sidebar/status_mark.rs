//! A thread's state as the classic desktop drew it: one 3×3 pixel grid whose
//! cells change with the state (AgentStatusDot's `.o8-fam`, Q 2026-07-12), and
//! the classic labels. An idle thread, and a chat that only talked, draw
//! nothing; the mark appears only when something runs, waits, broke, stopped
//! or merged.
use super::{Row, ThreadList};
use crate::client::Session;
use crate::theme::current as theme;
use gpui::{Animation, AnimationExt, AnyElement, ElementId, Rgba, div, prelude::*, px};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum State {
    Running,
    Review,
    Rejected,
    Blocked,
    Stopped,
    Merged,
}

impl State {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Review => "review",
            Self::Rejected => "rejected",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Merged => "merged",
        }
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Running => "Running",
            Self::Review => "Review",
            Self::Rejected => "Rejected",
            Self::Blocked => "Blocked",
            Self::Stopped => "Stopped",
            Self::Merged => "Merged",
        }
    }
    /// Classic's palette: blue runs, grey waits on you, amber was declined,
    /// red broke, green merged.
    pub(crate) fn color(self) -> Rgba {
        match self {
            Self::Running => theme().accent,
            Self::Review => gpui::rgb(0x94a3b8),
            Self::Rejected => gpui::rgb(0xf97316),
            Self::Blocked => theme().danger,
            Self::Stopped => theme().text_muted,
            Self::Merged => theme().success,
        }
    }
}

/// Classic `agentStatusToDotState`, on the fields o8 next has. Done, ready and
/// no-change outcomes are idle: only a real merge reads as merged.
pub(crate) fn state(s: &Session, running: bool) -> Option<State> {
    let status = s.status.trim().to_lowercase();
    let outcome = s.outcome.as_deref().unwrap_or("").trim().to_lowercase();
    Some(match status.as_str() {
        "blocked" | "error" | "failed" => State::Blocked,
        _ if s.rejected
            || matches!(
                status.as_str(),
                "rejected" | "needs-revision" | "changes_requested"
            ) =>
        {
            State::Rejected
        }
        _ if running || matches!(status.as_str(), "launching" | "recovering") => State::Running,
        "awaiting_human" | "awaiting_input" | "input" | "waiting" | "approval"
        | "awaiting_review" | "review" | "reviewing" => State::Review,
        _ if matches!(outcome.as_str(), "asked" | "pr_opened") => State::Review,
        "stopped" | "interrupted" | "cancelled" => State::Stopped,
        _ if matches!(outcome.as_str(), "stopped" | "interrupted") => State::Stopped,
        "merged" | "released" => State::Merged,
        _ if outcome == "merged" => State::Merged,
        _ => return None,
    })
}

const CELL: f32 = 3.;
const STEP: f32 = 4.;
pub(crate) const SIZE: f32 = 11.;

/// The 3×3 mark, 11 px. Running breathes (centre against the ring, as
/// classic's 1.9 s sine); the rest hold the frame that names them.
pub(crate) fn mark(state: State, id: &str) -> AnyElement {
    let color = state.color();
    let cell = |i: usize, alpha: f32| {
        div()
            .absolute()
            .left(px((i % 3) as f32 * STEP))
            .top(px((i / 3) as f32 * STEP))
            .size(px(CELL))
            .rounded(px(0.75))
            .bg(color)
            .opacity(alpha)
    };
    let base = div().relative().flex_shrink_0().size(px(SIZE));
    if state == State::Running {
        let sine = |delta: f32| 0.15 + 0.85 * (0.5 - 0.5 * (delta * std::f32::consts::TAU).cos());
        let ring = div()
            .absolute()
            .size_full()
            .children((0..9).filter(|i| *i != 4).map(|i| cell(i, 1.)))
            .with_animation(
                ElementId::Name(format!("mark-ring-{id}").into()),
                Animation::new(Duration::from_millis(1900)).repeat(),
                move |el, delta| el.opacity(sine(delta + 0.5)),
            );
        let centre = div()
            .absolute()
            .size_full()
            .child(cell(4, 1.))
            .with_animation(
                ElementId::Name(format!("mark-centre-{id}").into()),
                Animation::new(Duration::from_millis(1900)).repeat(),
                move |el, delta| el.opacity(sine(delta)),
            );
        return base.child(ring).child(centre).into_any_element();
    }
    // Reading order, 4 = centre.
    let alphas: [f32; 9] = match state {
        // Hourglass: the sand still at the top.
        State::Review => [1., 1., 1., 0.45, 0.45, 0.45, 0.18, 0.18, 0.18],
        // Gravity: the outer cells fallen to the floor, the centre holding.
        State::Rejected | State::Blocked | State::Stopped => {
            [0.15, 0.15, 0.15, 0.15, 1., 0.15, 1., 1., 1.]
        }
        // Settle: every cell in.
        _ => [1.; 9],
    };
    base.children(alphas.iter().enumerate().map(|(i, a)| cell(i, *a)))
        .into_any_element()
}

impl ThreadList {
    /// A thread row's state, when it has one to show.
    pub(super) fn row_state(&self, row: &Row) -> Option<State> {
        let id = row.id.as_deref()?;
        let session = self.sessions.iter().find(|s| s.id == id)?;
        state(session, row.running)
    }
    /// The row's mark at its right edge, with its label as the tooltip.
    pub(super) fn row_mark(&self, row: &Row) -> Option<AnyElement> {
        let state = self.row_state(row)?;
        let id = row.id.clone()?;
        let selector = format!("thread-state-{}-{id}", state.key());
        let tip: gpui::SharedString = state.label().into();
        Some(
            div()
                .id(ElementId::Name(format!("state:{id}").into()))
                .debug_selector(move || selector.clone())
                .flex_shrink_0()
                .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone())).into())
                .child(mark(state, &id))
                .into_any_element(),
        )
    }
}
