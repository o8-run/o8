//! Extra named links inside the existing trace, leaving its timeline untouched.
use super::*;
use crate::{activity::Step, retained::RowState};
use gpui::{AnyElement, SharedString};
use std::{cell::RefCell, rc::Rc};

pub(crate) fn element(state: Rc<RefCell<RowState>>, steps: &[Step]) -> AnyElement {
    let state = state.borrow();
    let Some(inspector) = state.subagents.clone() else {
        return div().into_any_element();
    };
    let mut references = steps
        .iter()
        .flat_map(|s| s.delegations.clone())
        .collect::<Vec<_>>();
    let mut seen = std::collections::HashSet::new();
    references.retain(|r| seen.insert(r.id.clone()));
    let links = references
        .into_iter()
        .map(|reference| {
            let known = state
                .subagent_agents
                .iter()
                .find(|a| a.id == reference.id || a.session.as_ref() == Some(&reference.id));
            let title = known.map_or(reference.title, |a| a.title.clone());
            let status = known.map_or("Reading status".into(), |a| a.status.clone());
            let shown_title = title.clone();
            let id = reference.id.clone();
            let selector = format!("subagent-trace-{id}");
            let inspector = inspector.clone();
            let activate = move |w: &mut Window, cx: &mut App| {
                inspector.update(cx, |s, cx| s.inspect(Some(id.clone()), w, cx))
            };
            let activate = Rc::new(activate);
            let key = activate.clone();
            div()
                .id(SharedString::from(selector.clone()))
                .debug_selector(move || selector.clone())
                .focusable()
                .cursor_pointer()
                .rounded(px(6.))
                .px(px(7.))
                .py(px(4.))
                .text_size(px(12.))
                .text_color(theme().text_secondary)
                .hover(|v| v.bg(theme().hover))
                .focus(|v| v.bg(theme().selection))
                .tooltip(move |_, cx| {
                    cx.new(|_| crate::icon::Tip(format!("Inspect {title} · {status}").into()))
                        .into()
                })
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
                .child(div().child(shown_title))
                .child(
                    div()
                        .text_size(px(9.5))
                        .text_color(theme().text_muted)
                        .child(
                            known
                                .map_or("Reading status", |a| a.status.as_str())
                                .to_string(),
                        ),
                )
        })
        .collect::<Vec<_>>();
    if links.is_empty() {
        return div().into_any_element();
    }
    div()
        .debug_selector(|| "trace-subagents".into())
        .pl(px(26.))
        .py(px(5.))
        .flex()
        .flex_wrap()
        .gap(px(6.))
        .children(links)
        .into_any_element()
}
