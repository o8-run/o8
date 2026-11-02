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

/// "started working", then in place "finished"; a mix says which is which.
pub(crate) fn verb(items: &[&Item]) -> &'static str {
    let working = items.iter().filter(|i| i.group == Group::Working).count();
    if working == items.len() {
        "started working"
    } else if items.iter().all(|i| i.failed) {
        "failed"
    } else if working > 0 {
        "working"
    } else if items.iter().all(|i| i.group == Group::Done) {
        "finished"
    } else {
        "need attention"
    }
}

fn name(
    state: &RowState,
    item: &Item,
    inspector: Option<&Entity<Inspector>>,
    arrive: f32,
) -> AnyElement {
    let id = item.id.clone();
    let selector = format!("subagent-trace-{id}");
    let shown: String = item.title.chars().take(NAME).collect();
    let shown = if item.title.chars().count() > NAME {
        format!("{}…", shown.trim_end())
    } else {
        shown
    };
    let color = if item.failed {
        theme().danger
    } else {
        theme().text_secondary
    };
    let base = div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector.clone())
        .whitespace_nowrap()
        .opacity(arrive)
        .text_color(color);
    let Some(inspector) = inspector.cloned() else {
        return base.child(shown).into_any_element();
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
        .rounded(px(4.))
        .hover(|v| v.text_color(theme().text))
        .focus(|v| v.bg(theme().selection))
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
        .child(shown)
        .into_any_element()
}

/// "#  Quick calculation and Sentence edit started working". The bool asks for
/// another frame while a name or the verb is still arriving.
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
    let working = items.iter().any(|i| i.group == Group::Working);
    let settled = !trace.live;
    let mut animating = false;
    let mut line = div()
        .debug_selector(|| "trace-subagents".into())
        .min_h(px(crate::trace::ROW))
        .py(px(4.))
        .flex()
        .flex_wrap()
        .items_center()
        .text_size(px(12.5))
        .line_height(px(18.));
    let marks =
        div()
            .mr(px(7.))
            .flex()
            .items_center()
            .gap(px(2.))
            .children(items.iter().take(3).map(|item| {
                crate::icon::stroke(
                    MARK,
                    if item.group == Group::Working {
                        theme().accent
                    } else {
                        theme().text_muted
                    },
                    13.,
                    2.,
                )
            }));
    line = line.child(marks);
    // Finished names read first, then the ones still going.
    let sets: Vec<Vec<&Item>> = [
        items.iter().filter(|i| i.group != Group::Working).collect(),
        items.iter().filter(|i| i.group == Group::Working).collect(),
    ]
    .into_iter()
    .filter(|set: &Vec<&Item>| !set.is_empty())
    .collect();
    let mut shown = 0;
    for (set_index, set) in sets.iter().enumerate() {
        if set_index > 0 {
            line = line.child(
                div()
                    .whitespace_nowrap()
                    .text_color(theme().text_muted)
                    .child(",\u{a0}"),
            );
        }
        let count = set.len();
        for (position, item) in set.iter().enumerate() {
            if shown == NAMES {
                break;
            }
            shown += 1;
            let arrived = crate::trace::seen(&format!("subagent:{row}:{}", item.id), settled);
            let arrive = crate::trace::progress_after(
                arrived,
                crate::trace::STAGGER * position as u32,
                crate::trace::APPEAR,
            );
            animating |= arrive < 1.;
            line = line.child(name(&state, item, inspector.as_ref(), arrive));
            let joiner = if position + 1 == count {
                None
            } else if position + 2 == count {
                Some("\u{a0}and\u{a0}")
            } else {
                Some(",\u{a0}")
            };
            if let Some(joiner) = joiner.filter(|_| shown < NAMES) {
                line = line.child(
                    div()
                        .whitespace_nowrap()
                        .text_color(theme().text_muted)
                        .opacity(arrive)
                        .child(joiner),
                );
            }
        }
        let verb = verb(set);
        let swap = crate::trace::progress(
            crate::trace::seen(&format!("subagent:{row}:{set_index}:{verb}"), settled),
            crate::trace::SWAP,
        );
        animating |= swap < 1.;
        let text = format!("\u{a0}{verb}");
        let label: AnyElement = if verb == "started working" || verb == "working" {
            crate::trace::shimmer(&text, theme().text_muted, theme().text, beat).into_any_element()
        } else {
            div().child(text).into_any_element()
        };
        line = line.child(
            div()
                .whitespace_nowrap()
                .text_color(theme().text_muted)
                .opacity(0.35 + 0.65 * swap)
                .child(label),
        );
    }
    if items.len() > NAMES {
        let inspector = inspector.clone();
        line = line.child(
            div()
                .id("subagent-trace-more")
                .debug_selector(|| "subagent-trace-more".into())
                .ml(px(6.))
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
