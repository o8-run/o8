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

pub(crate) const MARK: &str = "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18";
const NAME: usize = 32;
const NAMES: usize = 4;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Item {
    pub id: String,
    pub title: String,
    pub group: Group,
    pub failed: bool,
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
            let running = step.status == "running" && trace.live;
            let group = known.map_or(if running { Group::Working } else { Group::Done }, |a| {
                a.group
            });
            items.push(Item {
                id: id.to_owned(),
                title: known.map_or(fallback, |a| a.title.clone()),
                group,
                failed: known.map_or(step.status == "failed", |a| a.status == "Failed"),
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
    let items = items(steps, trace, &state.subagent_agents);
    if items.is_empty() {
        return None;
    }
    let inspector = state.subagents.clone();
    let settled = !trace.live;
    let mut animating = items.iter().any(|i| i.group == Group::Working);
    let mut line = div()
        .debug_selector(|| "trace-subagents".into())
        .py(px(4.))
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.))
        .text_size(px(12.5))
        .line_height(px(18.));
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
        line = line.child(card(&state, item, inspector.as_ref(), arrive, swap, beat));
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
    Some((line.into_any_element(), animating))
}
