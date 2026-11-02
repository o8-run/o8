//! A thread's state as the classic desktop drew it: one 3×3 pixel grid whose
//! cells change with the state (AgentStatusDot's `.o8-fam`, Q 2026-07-12), and
//! the classic labels. An idle thread, and a chat that only talked, draw
//! nothing; the mark appears only when something runs, waits, broke, stopped
//! or merged.
use super::{Row, ThreadList};
use crate::client::Session;
use crate::theme::current as theme;
use gpui::{AnyElement, Context, ElementId, Rgba, div, prelude::*, px};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum State {
    Running,
    Review,
    Rejected,
    Blocked,
    Stopped,
    Merged,
    /// A snoozed thread: classic's idle Drift, the one mark idle ever drew.
    Snoozed,
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
            Self::Snoozed => "snoozed",
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
            Self::Snoozed => "Snoozed",
        }
    }
    /// Classic's palette: blue runs, grey waits on you, amber was declined,
    /// red broke, green merged.
    pub(crate) fn color(self) -> Rgba {
        match self {
            Self::Running => theme().accent,
            Self::Review => crate::theme::review_mark(),
            Self::Rejected => crate::theme::rejected_mark(),
            Self::Blocked => theme().danger,
            Self::Stopped => theme().text_muted,
            Self::Merged => theme().success,
            Self::Snoozed => theme().text_muted,
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

/// One loop of classic's Gravity.
const PERIOD: Duration = Duration::from_millis(2400);

/// Linear between (time, value) keys over 0..1.
fn keyed(t: f32, keys: &[(f32, f32)]) -> f32 {
    let t = t.rem_euclid(1.);
    keys.windows(2)
        .find(|w| t <= w[1].0)
        .map_or(keys[keys.len() - 1].1, |w| {
            let span = (w[1].0 - w[0].0).max(f32::EPSILON);
            w[0].1 + (w[1].1 - w[0].1) * ((t - w[0].0) / span)
        })
}

/// Each cell's (opacity, drop in px) at `delta` through the loop, from
/// classic's `.o8-fam` keyframes in globals.css.
pub(crate) fn frame(state: State, delta: f32) -> [(f32, f32); 9] {
    let secs = PERIOD.as_secs_f32();
    // A CSS animation-delay of `d` seconds, as a fraction of this loop.
    let at = |d: f32| delta - d / secs;
    let mut cells = still(state);
    match state {
        // Gravity: the outer cells fall and fade, the centre holds.
        State::Blocked | State::Rejected => {
            for (i, cell) in cells.iter_mut().enumerate() {
                if i == 4 {
                    *cell = (1., 0.);
                    continue;
                }
                let (drop, delay) = [(3., 0.), (3.5, -0.12), (4., -0.24)][i / 3];
                let fall = keyed(
                    at(delay),
                    &[(0., 0.), (0.2, 1.), (0.7, 1.), (0.85, 0.), (1., 0.)],
                );
                *cell = (1. - 0.9 * fall, drop * fall);
            }
        }
        _ => {}
    }
    cells
}

impl State {
    /// Only what needs a human moves (Q, 2026-10-31): a failure or a block,
    /// and a rejection. The rest hold one telling moment of their classic
    /// loop; their colour already says enough.
    pub(crate) fn moves(self) -> bool {
        MOVING.contains(&self)
    }
}

/// The still pose of a state that does not move.
fn still(state: State) -> [(f32, f32); 9] {
    let alphas = match state {
        // Breathe, at the centre's peak.
        State::Running => [0.45, 0.45, 0.45, 0.45, 1., 0.45, 0.45, 0.45, 0.45],
        // Hourglass, with the top still full.
        State::Review => [1., 1., 1., 0.45, 0.45, 0.45, 0.18, 0.18, 0.18],
        // Gravity: the centre holds and the rest has fallen.
        State::Rejected | State::Blocked | State::Stopped => {
            [0.15, 0.15, 0.15, 0.15, 1., 0.15, 1., 1., 1.]
        }
        // Settle, settled.
        State::Merged => [1.; 9],
        // Drift: one faint spark on the perimeter.
        State::Snoozed => [0.4, 0.1, 0.1, 0.1, 0.12, 0.1, 0.1, 0.1, 0.1],
    };
    alphas.map(|alpha| (alpha, 0.))
}

/// Classic ran these in CSS for free. In GPUI each step rebuilds the window
/// (eight marks: 57% of a core at full rate), so they step at 5 fps and only
/// when a drawn mark would look different: Gravity mostly holds still.
const PACE: Duration = Duration::from_millis(200);
const MOVING: [State; 2] = [State::Blocked, State::Rejected];
static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// A moving state's cells right now.
fn now(state: State) -> [(f32, f32); 9] {
    let loop_ms = PERIOD.as_millis();
    frame(
        state,
        (EPOCH.elapsed().as_millis() % loop_ms) as f32 / loop_ms as f32,
    )
}

/// The bit `ThreadList::mark_drawn` keeps for a moving state.
pub(super) fn bit(state: State) -> u8 {
    MOVING
        .iter()
        .position(|s| *s == state)
        .map_or(0, |i| 1 << i)
}

/// Redraws the list when a moving mark drawn since the last redraw has
/// changed, and stops once a redraw draws none (none showing, or the
/// sidebar hidden).
pub(super) fn pace(cx: &mut Context<ThreadList>) {
    cx.spawn(async move |this, cx| {
        // Each moving state's last drawn look, coarse enough to skip steps a
        // reader could not tell apart.
        let mut shown = [[(0i16, 0i16); 9]; 2];
        loop {
            cx.background_executor().timer(PACE).await;
            let going = this.update(cx, |list, cx| {
                let drawn = list.mark_drawn.get();
                if drawn == 0 {
                    list.mark_pace = false;
                    return false;
                }
                let mut changed = false;
                for (i, state) in MOVING.into_iter().enumerate() {
                    let look = now(state)
                        .map(|(a, y)| ((a * 40.).round() as i16, (y * 2.).round() as i16));
                    if drawn & bit(state) != 0 && look != shown[i] {
                        shown[i] = look;
                        changed = true;
                    }
                }
                if changed {
                    list.mark_drawn.set(0);
                    cx.notify();
                }
                true
            });
            if !going.unwrap_or(false) {
                break;
            }
        }
    })
    .detach();
}

/// The 3×3 mark, 11 px; a moving state at this moment of its loop.
pub(crate) fn mark(state: State) -> AnyElement {
    let color = state.color();
    let cells = if state.moves() {
        now(state)
    } else {
        still(state)
    };
    div()
        .relative()
        .flex_shrink_0()
        .size(px(SIZE))
        .children(cells.into_iter().enumerate().map(|(i, (alpha, drop))| {
            div()
                .absolute()
                .left(px((i % 3) as f32 * STEP))
                .top(px((i / 3) as f32 * STEP + drop))
                .size(px(CELL))
                .rounded(px(0.75))
                .bg(color)
                .opacity(alpha)
        }))
        .into_any_element()
}

impl ThreadList {
    /// A thread row's state, when it has one to show.
    pub(super) fn row_state(&self, row: &Row) -> Option<State> {
        let id = row.id.as_deref()?;
        let session = self.sessions.iter().find(|s| s.id == id)?;
        // A snoozed thread with nothing louder to say shows the faint idle mark.
        state(session, row.running).or_else(|| self.snoozed(id).then_some(State::Snoozed))
    }
    /// The row's mark at its right edge, with its label as the tooltip.
    pub(super) fn row_mark(&self, row: &Row) -> Option<AnyElement> {
        let state = self.row_state(row)?;
        let id = row.id.clone()?;
        self.mark_drawn.set(self.mark_drawn.get() | bit(state));
        let selector = format!("thread-state-{}-{id}", state.key());
        let tip: gpui::SharedString = state.label().into();
        Some(
            div()
                .id(ElementId::Name(format!("state:{id}").into()))
                .debug_selector(move || selector.clone())
                .flex_shrink_0()
                .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone())).into())
                .child(mark(state))
                .into_any_element(),
        )
    }
}
