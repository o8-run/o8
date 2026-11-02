//! Shared inspector routing. Opening a trace keeps the main selection.
use super::*;
use crate::subagents::{Inspector, model::Scope};
#[derive(Default)]
struct Inspectors {
    workspace: std::collections::HashMap<String, Entity<Inspector>>,
    current: Option<Entity<Inspector>>,
    anchor: Option<(Option<String>, Option<Tab>, Option<gpui::EntityId>)>,
    return_panel: Option<ReturnPanel>,
}
struct ReturnPanel {
    workspace: Option<String>,
    selected: Tool,
    active: usize,
    tabs: Vec<Tool>,
    lower: Option<Tool>,
    lower_tabs: Vec<Tool>,
    maximized: bool,
}
pub(super) fn watch(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let owner = cx.weak_entity();
    let handle = window.window_handle();
    s.subscriptions
        .push(cx.observe_new::<Inspector>(move |_, _, cx| {
            let owner = owner.clone();
            let view = cx.entity();
            cx.defer(move |cx| {
                let _ = owner.update(cx, |s, cx| {
                    s.subscriptions
                        .push(cx.observe(&view, |_, _, cx| cx.notify()));
                    s.subscriptions.push(cx.subscribe(
                        &view,
                        move |_, view, event: &crate::subagents::Open, cx| {
                            if event.0 != handle {
                                return;
                            }
                            let owner = cx.weak_entity();
                            cx.defer(move |cx| {
                                let _ = handle.update(cx, |_, w, cx| {
                                    let _ = owner.update(cx, |s, cx| {
                                        s.features.get::<Inspectors>().current = Some(view.clone());
                                        let primary = current(s, cx);
                                        s.features.get::<Inspectors>().anchor = Some((
                                            s.state.selected.clone(),
                                            s.active(),
                                            primary.map(|v| v.entity_id()),
                                        ));
                                        if is_open(s) && in_panel(s) {
                                            focus(s, w, cx);
                                        } else {
                                            show(s, Tool::Subagents, w, cx);
                                        }
                                    });
                                });
                            });
                        },
                    ));
                    s.subscriptions.push(cx.subscribe(
                        &view,
                        move |_, _, event: &crate::subagents::Close, cx| {
                            if event.0 != handle {
                                return;
                            }
                            let restore = event.1.clone();
                            let owner = cx.weak_entity();
                            cx.defer(move |cx| {
                                let _ = handle.update(cx, |_, w, cx| {
                                    let _ = owner.update(cx, |s, cx| {
                                        if !restore_panel(s, cx) && is_open(s) {
                                            toggle(s, w, cx);
                                        }
                                        if let Some(focus) = restore {
                                            focus.focus(w);
                                        }
                                    });
                                });
                            });
                        },
                    ));
                });
            });
        }));
}
pub(super) fn current(s: &mut Shell, cx: &mut Context<Shell>) -> Option<Entity<Inspector>> {
    if let Some(Content::Grid(view)) = s.active().and_then(|tab| s.content.get(&s.key(&tab))) {
        if let Some(inspector) = view.read(cx).shell_subagents() {
            return Some(inspector);
        }
    }
    if let Some(Content::Session(view)) = s.active().and_then(|tab| s.content.get(&s.key(&tab))) {
        if let Some(inspector) = view.read(cx).shell_subagents() {
            return Some(inspector);
        }
    }
    let repo = s.state.selected.clone()?;
    if let Some(view) = s.features.get::<Inspectors>().workspace.get(&repo) {
        return Some(view.clone());
    }
    let client = s.client.in_workspace(&repo);
    let view = cx.new(|cx| {
        Inspector::new(
            client,
            Scope {
                repo: repo.clone(),
                parent: None,
            },
            cx,
        )
    });
    s.features
        .get::<Inspectors>()
        .workspace
        .insert(repo, view.clone());
    Some(view)
}
pub(super) fn prepare(s: &mut Shell, cx: &mut Context<Shell>) {
    let panel = s.features.get::<Panel>();
    if (panel.selected != Tool::Subagents && panel.lower != Some(Tool::Subagents))
        || !panel.motion.is_open()
    {
        let return_panel = panel.motion.is_open().then(|| ReturnPanel {
            workspace: s.state.selected.clone(),
            selected: panel.selected,
            active: panel.active,
            tabs: panel.tabs.clone(),
            lower: panel.lower,
            lower_tabs: panel.lower_tabs.clone(),
            maximized: panel.maximized,
        });
        s.features.get::<Inspectors>().return_panel = return_panel;
    }
    if s.features.get::<Inspectors>().current.is_none() {
        let view = current(s, cx);
        s.features.get::<Inspectors>().current = view;
    }
}
pub(super) fn in_panel(s: &Shell) -> bool {
    s.features.read::<Panel>().is_some_and(|panel| {
        panel.selected == Tool::Subagents || panel.lower == Some(Tool::Subagents)
    })
}
fn restore_panel(s: &mut Shell, cx: &mut Context<Shell>) -> bool {
    let Some(saved) = s.features.get::<Inspectors>().return_panel.take() else {
        return false;
    };
    if saved.workspace != s.state.selected {
        return false;
    }
    let panel = s.features.get::<Panel>();
    panel.selected = saved.selected;
    panel.active = saved.active;
    panel.tabs = saved.tabs;
    panel.lower = saved.lower;
    panel.lower_tabs = saved.lower_tabs;
    panel.maximized = saved.maximized;
    panel.into_lower = false;
    panel.menu = None;
    panel.motion.set(true);
    panel.morph.set(true);
    panel.content = Transition::settled(200, true);
    s.state.right_panel.visible = true;
    layout::save(s);
    cx.notify();
    true
}
pub(super) fn focus(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    if let Some(view) = s.features.get::<Inspectors>().current.clone() {
        view.update(cx, |v, _| {
            v.open = true;
            v.focus(w);
        });
    }
}
pub(super) fn tick(s: &mut Shell, cx: &mut Context<Shell>) {
    let primary = current(s, cx);
    let anchor = (
        s.state.selected.clone(),
        s.active(),
        primary.as_ref().map(|v| v.entity_id()),
    );
    if s.features.get::<Inspectors>().anchor.as_ref() != Some(&anchor) {
        let view = primary.clone();
        let state = s.features.get::<Inspectors>();
        state.current = view;
        state.anchor = Some(anchor);
    }
    let mut views = primary.into_iter().collect::<Vec<_>>();
    let state = s.features.get::<Inspectors>();
    if let Some(view) = &state.current {
        if !views.contains(view) {
            views.push(view.clone());
        }
    }
    for view in views {
        view.update(cx, |v, cx| v.tick(false, cx));
    }
}
pub(super) fn element(s: &Shell, _: &mut Context<Shell>) -> AnyElement {
    s.features
        .read::<Inspectors>()
        .and_then(|state| state.current.clone())
        .map(|v| v.into_any_element())
        .unwrap_or_else(|| {
            div()
                .p(px(16.))
                .child("Select a workspace to inspect subagents.")
                .into_any_element()
        })
}
#[cfg(test)]
pub(super) fn probe(s: &Shell, cx: &App) -> serde_json::Value {
    s.features
        .read::<Inspectors>()
        .and_then(|state| state.current.as_ref())
        .map(|view| view.read(cx).probe())
        .unwrap_or(serde_json::Value::Null)
}
pub(super) fn summary_button(s: &mut Shell, cx: &mut Context<Shell>) -> AnyElement {
    let view = current(s, cx);
    let summary = view
        .as_ref()
        .map(|v| v.read(cx).summary())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Subagents".into());
    let label = summary.clone();
    let keyboard_view = view.clone();
    super::super::header::pill("header-subagents", "Inspect subagents", view.is_some())
        .debug_selector(|| "header-subagents".into())
        .focusable()
        .px(px(8.))
        .text_size(px(11.))
        .on_click(cx.listener(move |_, _, w, cx| {
            if let Some(view) = &view {
                view.update(cx, |v, cx| v.inspect(None, w, cx));
            }
            cx.stop_propagation();
        }))
        .on_key_down(cx.listener(move |_, e: &KeyDownEvent, w, cx| {
            if matches!(e.keystroke.key.as_str(), "enter" | "space") {
                if let Some(view) = &keyboard_view {
                    view.update(cx, |v, cx| v.inspect(None, w, cx));
                }
                cx.stop_propagation();
            }
        }))
        .child(label)
        .into_any_element()
}
