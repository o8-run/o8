//! The running reply's one line about its subagents, under the words: names
//! that open their own tab, reporting in place as each starts and finishes.
use super::*;
use crate::{
    activity::Step,
    model::{Row, Trace},
    retained::RowState,
};
use gpui::{AnyElement, SharedString};
use model::Group;
use std::{cell::RefCell, rc::Rc};

thread_local! {
    /// When this window first saw each live agent working, and when it stopped,
    /// epoch ms: a live delegate call carries no times of its own.
    static WATCHED: RefCell<std::collections::HashMap<String, (f64, Option<f64>)>> =
        RefCell::default();
}

const WATCH_LIMIT: usize = 256;
pub(crate) const MARK: &str = "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18";
const NAME: usize = 32;
const NAMES: usize = 4;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Item {
    pub id: String,
    pub title: String,
    pub group: Group,
    pub failed: bool,
    /// What the agent is doing now, as its worker last reported.
    pub activity: Option<String>,
    pub started: Option<f64>,
    pub finished: Option<f64>,
}

fn title(step: &Step) -> String {
    step.subject
        .as_deref()
        .and_then(|s| s.lines().next())
        .filter(|s| !s.trim().is_empty())
        .map_or_else(|| "Subagent".into(), |s| s.chars().take(80).collect())
}

/// The turn's delegate calls that have no packet or shared worker behind them,
/// from any house: its own call is the only record of the work.
pub(crate) fn native_agents(rows: &[Rc<RefCell<RowState>>]) -> Vec<model::Agent> {
    let mut agents = Vec::new();
    for row in rows {
        let state = row.borrow();
        let Row::Activity { steps, trace, .. } = &state.row else {
            continue;
        };
        for step in steps
            .iter()
            .filter(|s| s.delegate && s.delegations.is_empty())
        {
            let (group, status) = match step.status.as_str() {
                "running" if trace.live => (Group::Working, "Working"),
                // The lead's turn stays open while its background agents run.
                "ok" if step.launched && trace.live => (Group::Working, "Working"),
                "failed" => (Group::Attention, "Failed"),
                _ => (Group::Done, "Done"),
            };
            agents.push(model::Agent {
                shared: false,
                native: true,
                prompt: step.delegate_prompt.clone(),
                run: step.id.clone(),
                id: step.id.clone(),
                title: title(step),
                runtime: String::new(),
                model: None,
                effort: None,
                parent: None,
                session: step.thread.clone(),
                group,
                status: status.into(),
                progress: None,
                result: step.delegate_result.clone(),
                started: step.started,
                finished: step.finished,
            });
        }
    }
    agents
}

/// Whether a row names subagents and needs the inspector bound.
pub(crate) fn delegates(row: &Row) -> bool {
    matches!(row, Row::Activity { steps, trace, .. }
        if !trace.helpers.is_empty()
            || steps.iter().any(|s| s.delegate || !s.delegations.is_empty()))
}

/// What the line reports: this row's calls, or the whole turn's on the live row.
pub(crate) fn items(steps: &[Step], trace: &Trace, agents: &[model::Agent]) -> Vec<Item> {
    if trace.helpers_below {
        return vec![];
    }
    let source = if trace.helpers.is_empty() {
        steps
    } else {
        &trace.helpers
    };
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for step in source
        .iter()
        .filter(|s| s.delegate || !s.delegations.is_empty())
    {
        let mut push = |id: &str, fallback: String| {
            if !seen.insert(id.to_owned()) {
                return;
            }
            let known = agents
                .iter()
                .find(|a| a.id == id || a.session.as_deref() == Some(id));
            let running =
                (step.status == "running" || step.launched && step.status == "ok") && trace.live;
            let group = known.map_or(if running { Group::Working } else { Group::Done }, |a| {
                a.group
            });
            items.push(Item {
                id: id.to_owned(),
                title: known.map_or(fallback, |a| a.title.clone()),
                group,
                failed: known.map_or(step.status == "failed", |a| a.status == "Failed"),
                activity: known.and_then(|a| a.progress.clone()),
                started: known.and_then(|a| a.started).or(step.started),
                finished: known
                    .map_or(step.finished, |a| a.finished)
                    .filter(|_| group != Group::Working),
            });
        };
        if step.delegations.is_empty() {
            push(&step.id, title(step));
        }
        for reference in &step.delegations {
            push(&reference.id, reference.title.clone());
        }
    }
    items
}

/// One color per agent, so its card, tab and header read as the same agent.
pub(crate) fn agent_color(id: &str) -> gpui::Rgba {
    let hash = id.bytes().fold(0u32, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(u32::from(byte))
    });
    crate::theme::agent_color(hash as usize)
}

fn status(item: &Item) -> &'static str {
    if item.failed {
        "failed"
    } else {
        match item.group {
            Group::Working => "working",
            Group::Attention => "needs you",
            Group::Done => "done",
        }
    }
}

fn card(
    state: &RowState,
    item: &Item,
    inspector: Option<&Entity<Inspector>>,
    arrive: f32,
    swap: f32,
    beat: f32,
) -> AnyElement {
    let id = item.id.clone();
    let selector = format!("subagent-trace-{id}");
    let shown: String = item.title.chars().take(NAME).collect();
    let shown = if item.title.chars().count() > NAME {
        format!("{}…", shown.trim_end())
    } else {
        shown
    };
    let color = agent_color(&item.id);
    let word = status(item);
    let label: AnyElement = if word == "working" {
        crate::trace::shimmer(word, theme().text_muted, theme().text, beat).into_any_element()
    } else {
        div().child(word).into_any_element()
    };
    let base = div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector.clone())
        .h(px(26.))
        .px(px(9.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(8.))
        .border_1()
        .border_color(gpui::Rgba { a: 0.32, ..color })
        .bg(gpui::Rgba { a: 0.1, ..color })
        .whitespace_nowrap()
        .opacity(arrive)
        .child(crate::icon::stroke(MARK, color, 13., 2.))
        .child(div().text_color(theme().text).child(shown))
        .child(
            div()
                .text_size(px(11.))
                .text_color(if item.failed {
                    theme().danger
                } else {
                    theme().text_muted
                })
                .opacity(0.35 + 0.65 * swap)
                .child(label),
        );
    let Some(inspector) = inspector.cloned() else {
        return base.into_any_element();
    };
    let focus = state.subagent_focus.get(&item.id).cloned();
    let return_focus = focus.clone();
    let activate = Rc::new(move |w: &mut Window, cx: &mut App| {
        if let Some(focus) = &return_focus {
            focus.focus(w);
        }
        inspector.update(cx, |s, cx| s.inspect(Some(id.clone()), w, cx))
    });
    let key = activate.clone();
    let tip = format!("Open {}", item.title);
    base.focusable()
        .when_some(focus, |v, focus| v.track_focus(&focus))
        .cursor_pointer()
        .hover(move |v| v.bg(gpui::Rgba { a: 0.2, ..color }))
        .focus(|v| v.border_color(theme().accent))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone().into())).into())
        .on_click(move |_, w, cx| {
            activate(w, cx);
            cx.stop_propagation();
        })
        .on_key_down(move |e: &KeyDownEvent, w, cx| {
            if matches!(e.keystroke.key.as_str(), "enter" | "space") {
                key(w, cx);
                cx.stop_propagation();
            } else if e.keystroke.key == "tab" {
                if e.keystroke.modifiers.shift {
                    w.focus_prev()
                } else {
                    w.focus_next()
                };
                cx.stop_propagation();
            }
        })
        .into_any_element()
}

/// One card per agent, each opening its own tab. The bool asks for another
/// frame while a card or its status is still arriving.
pub(crate) fn element(
    row: &str,
    state: Rc<RefCell<RowState>>,
    steps: &[Step],
    trace: &Trace,
    beat: f32,
) -> Option<(AnyElement, bool)> {
    let state = state.borrow();
    let now = crate::lineage::now_ms();
    let items: Vec<Item> = items(steps, trace, &state.subagent_agents)
        .into_iter()
        .map(|item| watch(&format!("{row}:{}", item.id), item, trace.live, now))
        .collect();
    if items.is_empty() {
        return None;
    }
    let inspector = state.subagents.clone();
    let settled = !trace.live;
    let mut animating = items.iter().any(|i| i.group == Group::Working);
    // Two or more agents read as a roster, one row each with what it is
    // doing and how long it has taken; one agent stays a single card.
    let roster = items.len() > 1;
    let mut line = div()
        .debug_selector(|| "trace-subagents".into())
        .py(px(4.))
        .flex()
        .gap(px(6.))
        .text_size(px(12.5))
        .line_height(px(18.))
        .when(roster, |v| {
            v.flex_col()
                .gap(px(4.))
                .p(px(6.))
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
        })
        .when(!roster, |v| v.flex_wrap().items_center());
    // Finished agents read first, then the ones still going.
    let ordered = items
        .iter()
        .filter(|i| i.group != Group::Working)
        .chain(items.iter().filter(|i| i.group == Group::Working));
    for (position, item) in ordered.take(NAMES).enumerate() {
        let arrived = crate::trace::seen(&format!("subagent:{row}:{}", item.id), settled);
        let arrive = crate::trace::progress_after(
            arrived,
            crate::trace::STAGGER * position as u32,
            crate::trace::APPEAR,
        );
        let swap = crate::trace::progress(
            crate::trace::seen(&format!("subagent:{row}:{}:{}", item.id, status(item)), settled),
            crate::trace::SWAP,
        );
        animating |= arrive < 1. || swap < 1.;
        let card = card(&state, item, inspector.as_ref(), arrive, swap, beat);
        line = line.child(if roster {
            roster_row(item, card, arrive)
        } else {
            card
        });
    }
    if items.len() > NAMES {
        let inspector = inspector.clone();
        line = line.child(
            div()
                .id("subagent-trace-more")
                .debug_selector(|| "subagent-trace-more".into())
                .ml(px(2.))
                .whitespace_nowrap()
                .cursor_pointer()
                .text_color(theme().text_muted)
                .hover(|v| v.text_color(theme().text))
                .on_click(move |_, w, cx| {
                    if let Some(inspector) = &inspector {
                        inspector.update(cx, |s, cx| s.inspect(None, w, cx));
                    }
                    cx.stop_propagation();
                })
                .child(format!("+{} more", items.len() - NAMES)),
        );
    }
    if roster {
        line = line.child(
            div()
                .debug_selector(|| "subagent-trace-summary".into())
                .px(px(3.))
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(summary(&items)),
        );
    }
    Some((line.into_any_element(), animating))
}

/// Fills in times the server didn't send from what this window watched: a
/// working agent starts its clock, and the clock stops once it isn't working.
/// An agent first seen finished keeps no time rather than a made-up one.
fn watch(key: &str, mut item: Item, live: bool, now: f64) -> Item {
    if item.started.is_some() {
        return item;
    }
    WATCHED.with(|watched| {
        let mut watched = watched.borrow_mut();
        let clock = if item.group == Group::Working && live {
            // Finished clocks only matter while their row is on screen; keep
            // the map small for a long-lived window.
            if watched.len() >= WATCH_LIMIT && !watched.contains_key(key) {
                watched.retain(|_, (_, end)| end.is_none());
            }
            let clock = watched.entry(key.to_owned()).or_insert((now, None));
            clock.1 = None;
            Some(*clock)
        } else {
            watched.get_mut(key).map(|clock| {
                clock.1.get_or_insert(now);
                *clock
            })
        };
        if let Some((started, finished)) = clock {
            item.started = Some(started);
            item.finished = item.finished.or(finished);
        }
    });
    item
}

/// A roster row: the agent's card, what it is doing now, and its time.
fn roster_row(item: &Item, card: AnyElement, arrive: f32) -> AnyElement {
    let selector = format!("subagent-roster-{}", item.id);
    div()
        .debug_selector(move || selector.clone())
        .flex()
        .items_center()
        .gap(px(8.))
        .min_w_0()
        .opacity(arrive)
        .child(div().flex_none().child(card))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(11.5))
                .text_color(theme().text_muted)
                .children(activity(item)),
        )
        .children(elapsed(item, crate::lineage::now_ms()).map(|time| {
            div()
                .flex_none()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(time)
        }))
        .into_any_element()
}

/// The worker's last report while it runs; a finished agent says nothing more.
fn activity(item: &Item) -> Option<String> {
    (item.group != Group::Done)
        .then(|| item.activity.as_deref())
        .flatten()
        .and_then(|text| text.lines().next())
        .map(str::to_owned)
}

/// How long the agent has run, or ran; nothing until its start is known.
fn elapsed(item: &Item, now: f64) -> Option<String> {
    let started = item.started?;
    Some(crate::trace::seconds(
        item.finished.unwrap_or(now) - started,
    ))
}

/// "2 working · 1 done", counting every agent, not only the rows shown.
fn summary(items: &[Item]) -> String {
    let count = |word: &str| items.iter().filter(|i| status(i) == word).count();
    ["working", "needs you", "failed", "done"]
        .into_iter()
        .filter_map(|word| match count(word) {
            0 => None,
            n => Some(format!("{n} {word}")),
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod roster_tests {
    use super::*;

    fn item(id: &str, group: Group) -> Item {
        Item {
            id: id.into(),
            title: id.into(),
            group,
            failed: false,
            activity: Some("Searching the worktree\nmore".into()),
            started: Some(1_000.),
            finished: None,
        }
    }

    #[test]
    fn a_running_agent_shows_its_last_report_and_a_live_time() {
        let working = item("a", Group::Working);
        assert_eq!(
            activity(&working).as_deref(),
            Some("Searching the worktree")
        );
        assert_eq!(elapsed(&working, 27_000.).as_deref(), Some("26s"));
        let done = Item {
            finished: Some(66_000.),
            ..item("b", Group::Done)
        };
        assert_eq!(activity(&done), None, "a finished agent says nothing more");
        assert_eq!(elapsed(&done, 999_000.).as_deref(), Some("1m 5s"));
        let unknown = Item {
            started: None,
            ..item("c", Group::Working)
        };
        assert_eq!(elapsed(&unknown, 5_000.), None);
    }

    #[test]
    fn a_watched_agent_keeps_the_time_it_ran_and_an_unwatched_one_has_none() {
        let fresh = |group| Item {
            started: None,
            ..item("w", group)
        };
        let working = watch("row:w", fresh(Group::Working), true, 1_000.);
        assert_eq!(working.started, Some(1_000.));
        let done = watch("row:w", fresh(Group::Done), true, 9_000.);
        assert_eq!(elapsed(&done, 50_000.).as_deref(), Some("8s"));
        let later = watch("row:w", fresh(Group::Done), false, 70_000.);
        assert_eq!(later.finished, Some(9_000.), "the stop time holds");
        let loaded = watch("row:old", fresh(Group::Done), false, 5_000.);
        assert_eq!(elapsed(&loaded, 5_000.), None);
    }

    #[test]
    fn finished_clocks_are_dropped_once_the_map_is_full() {
        let fresh = |group| Item {
            started: None,
            ..item("x", group)
        };
        for n in 0..WATCH_LIMIT {
            watch(&format!("full:{n}"), fresh(Group::Working), true, 1.);
            watch(&format!("full:{n}"), fresh(Group::Done), false, 2.);
        }
        watch("full:new", fresh(Group::Working), true, 3.);
        let size = WATCHED.with(|w| w.borrow().len());
        assert!(size < WATCH_LIMIT, "{size} clocks kept");
    }

    #[test]
    fn a_background_agent_is_working_until_its_turn_ends() {
        let launch = crate::activity::activity(
            "bg",
            &serde_json::json!({
                "name": "Agent", "status": "done",
                "args": {"description": "Sleep then date", "prompt": "p", "run_in_background": true},
                "result": "Async agent launched successfully. agentId: x",
            }),
            "",
        );
        assert!(launch.launched);
        let live = Trace {
            live: true,
            ..Default::default()
        };
        let items = super::items(std::slice::from_ref(&launch), &live, &[]);
        assert_eq!(
            items[0].group,
            Group::Working,
            "a launch notice isn't a finish"
        );
        assert_eq!(native_agents_for(&launch, &live), Group::Working);
        let settled = Trace::default();
        let items = super::items(std::slice::from_ref(&launch), &settled, &[]);
        assert_eq!(items[0].group, Group::Done);
        let answered = crate::activity::activity(
            "fg",
            &serde_json::json!({
                "name": "Agent", "status": "done",
                "args": {"description": "Run date", "prompt": "p"},
                "result": "Mon Nov 2",
            }),
            "",
        );
        assert!(!answered.launched);
        let items = super::items(std::slice::from_ref(&answered), &live, &[]);
        assert_eq!(
            items[0].group,
            Group::Done,
            "a foreground answer is a finish"
        );
    }

    fn native_agents_for(step: &Step, trace: &Trace) -> Group {
        let row = RowState::new(Row::Activity {
            id: "turn".into(),
            steps: vec![step.clone()],
            trace: trace.clone(),
        });
        native_agents(&[Rc::new(RefCell::new(row))])[0].group
    }

    #[test]
    fn the_summary_counts_every_agent_by_state() {
        let failed = Item {
            failed: true,
            ..item("d", Group::Done)
        };
        let items = [
            item("a", Group::Working),
            item("b", Group::Working),
            item("c", Group::Done),
            failed,
        ];
        assert_eq!(summary(&items), "2 working · 1 failed · 1 done");
    }
}
