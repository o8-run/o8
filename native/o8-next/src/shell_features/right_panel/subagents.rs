//! Shared inspector routing. Opening a trace keeps the main selection.
use super::*;
use crate::subagents::{Inspector, model::Scope};
#[derive(Default)]
pub(super) struct Inspectors {
    pub(super) workspace: std::collections::HashMap<String, Entity<Inspector>>,
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
    workspace(s, cx)
}
/// The workspace's own inspector: every agent it started, whichever chat
/// started it.
pub(super) fn workspace(s: &mut Shell, cx: &mut Context<Shell>) -> Option<Entity<Inspector>> {
    let repo = s.state.selected.clone()?;
    if let Some(view) = s.features.get::<Inspectors>().workspace.get(&repo) {
        return Some(view.clone());
    }
    let client = s.panel_client(&repo);
    let view = cx.new(|cx| {
        Inspector::new(
            client,
            Scope {
                repo: crate::shell::session::workspace_path(&repo).to_owned(),
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
/// Points the panel at the workspace's whole list, as its tool buttons and
/// the dock's See all open it.
pub(super) fn all(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(view) = workspace(s, cx) else {
        return;
    };
    share_native(s, &view, cx);
    view.update(cx, |view, cx| view.inspect(None, window, cx));
    s.features.get::<Inspectors>().current = Some(view);
}
/// The inspector a tab's chat or grid keeps for its own agents.
fn tab_inspector(s: &Shell, tab: &Tab, cx: &App) -> Option<Entity<Inspector>> {
    match s.content.get(&s.key(tab)) {
        Some(Content::Grid(view)) => view.read(cx).shell_subagents(),
        Some(Content::Session(view)) => view.read(cx).shell_subagents(),
        _ => None,
    }
}
/// The chat the workspace is on: the active tab's, else the chat tab nearest
/// it, so a pull request or file tab still reads that chat's agents.
pub(super) fn chat(s: &Shell, cx: &App) -> Option<Entity<Inspector>> {
    let workspace = s.current()?;
    let active = workspace.active.min(workspace.tabs.len().saturating_sub(1));
    (0..workspace.tabs.len())
        .flat_map(|step| [active.checked_sub(step), Some(active + step)])
        .flatten()
        .filter_map(|index| workspace.tabs.get(index))
        .find_map(|tab| tab_inspector(s, tab, cx))
}
/// An agent by id: the chat's lists first, then the workspace's own.
pub(super) fn find(s: &Shell, id: &str, cx: &App) -> Option<crate::subagents::model::Agent> {
    let workspace = s.state.selected.as_ref().and_then(|repo| {
        s.features
            .read::<Inspectors>()?
            .workspace
            .get(repo)
            .cloned()
    });
    s.current()
        .map_or(&[][..], |w| &w.tabs[..])
        .iter()
        .filter_map(|tab| tab_inspector(s, tab, cx))
        .chain(workspace)
        .find_map(|view| view.read(cx).agents.iter().find(|a| a.id == id).cloned())
}
/// The workspace list also shows the agents each chat read from its own
/// transcript; they have no packet for the workspace's read to find.
fn share_native(s: &Shell, view: &Entity<Inspector>, cx: &mut Context<Shell>) {
    let mut native: Vec<crate::subagents::model::Agent> = vec![];
    for tab in s.current().map_or(&[][..], |w| &w.tabs[..]) {
        let Some(chat) = tab_inspector(s, tab, cx) else {
            continue;
        };
        for agent in chat.read(cx).agents.iter().filter(|a| a.native) {
            if !native.iter().any(|known| known.id == agent.id) {
                native.push(agent.clone());
            }
        }
    }
    view.update(cx, |view, cx| view.set_native(native, cx));
}
/// `all` also keeps the workspace's whole list fresh, for the dock's count.
pub(super) fn tick(s: &mut Shell, all: bool, cx: &mut Context<Shell>) {
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
    if all {
        views.extend(chat(s, cx));
    }
    // The workspace list keeps its chats' transcript agents current while
    // the dock counts it or the panel shows it.
    let shown = s.state.selected.as_ref().and_then(|repo| {
        let state = s.features.read::<Inspectors>()?;
        let view = state.workspace.get(repo)?;
        (state.current.as_ref() == Some(view)).then(|| view.clone())
    });
    if let Some(view) = if all { workspace(s, cx) } else { shown } {
        share_native(s, &view, cx);
        views.push(view);
    }
    let state = s.features.get::<Inspectors>();
    views.extend(state.current.clone());
    let mut seen = std::collections::HashSet::new();
    views.retain(|view| seen.insert(view.entity_id()));
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
/// One tab per opened subagent, named for it; the directory has a tab only
/// while it is what shows.
pub(super) fn tabs(s: &Shell, cx: &mut Context<Shell>) -> Vec<AnyElement> {
    let p = s.features.read::<Panel>().unwrap();
    let shown = p.selected == Tool::Subagents;
    let view = s
        .features
        .read::<Inspectors>()
        .and_then(|state| state.current.clone());
    let Some(view) = view else {
        return vec![chrome::tool_tab(s, Tool::Subagents, cx)];
    };
    let (selected, open) = {
        let inspector = view.read(cx);
        let open: Vec<(String, String, bool)> = inspector
            .tabs
            .iter()
            .map(|id| {
                let agent = inspector.title_of(id);
                (
                    id.clone(),
                    agent.map_or("Subagent".to_string(), |a| a.title.clone()),
                    agent.is_some_and(|a| a.group == crate::subagents::model::Group::Working),
                )
            })
            .collect();
        (inspector.selected.clone(), open)
    };
    let mut tabs: Vec<AnyElement> = open
        .iter()
        .map(|(id, title, working)| {
            let (title, working) = (title.clone(), *working);
            let active = shown && selected.as_ref() == Some(id);
            let (open_id, close_id) = (id.clone(), id.clone());
            let (open_view, close_view) = (view.clone(), view.clone());
            let selector = format!("panel-subagent-tab-{id}");
            div()
                .id(SharedString::from(selector.clone()))
                .debug_selector(move || selector.clone())
                .relative()
                .h(px(28.))
                .max_w(px(180.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .rounded(px(7.))
                .when(active, |v| v.bg(theme().selection).child(p.scroll.probe()))
                .child(
                    chrome::button(
                        s,
                        format!("panel-subagent-{id}"),
                        title.clone(),
                        cx,
                        move |_, w, cx| {
                            open_view.update(cx, |v, cx| v.inspect(Some(open_id.clone()), w, cx))
                        },
                    )
                    .h(px(28.))
                    .min_w_0()
                    .pl(px(8.))
                    .pr(px(5.))
                    .gap(px(6.))
                    .when(active, |b| b.text_color(theme().text))
                    .child(crate::icon::stroke(
                        crate::subagents::trace::MARK,
                        crate::subagents::trace::agent_color(&id),
                        13.,
                        1.6,
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(title),
                    ),
                )
                .child(
                    chrome::bare(
                        s,
                        format!("panel-subagent-close-{id}"),
                        "Close subagent tab".to_string(),
                        cx,
                        move |s, w, cx| {
                            let empty =
                                close_view.update(cx, |v, cx| v.close_tab(&close_id, w, cx));
                            if empty {
                                close_directory(s, w, cx);
                            }
                        },
                    )
                    .w(px(16.))
                    .h(px(16.))
                    .mr(px(5.))
                    .rounded(px(4.))
                    .child(crate::icon::stroke(
                        "M18 6 6 18M6 6l12 12",
                        theme().text_faint,
                        10.,
                        2.5,
                    )),
                )
                .into_any_element()
        })
        .collect();
    if selected.is_none() || tabs.is_empty() {
        tabs.insert(0, chrome::tool_tab(s, Tool::Subagents, cx));
    }
    tabs
}
fn close_directory(s: &mut Shell, w: &mut Window, cx: &mut Context<Shell>) {
    let selected = s.features.get::<Panel>().selected;
    if let Some(index) = s
        .features
        .get::<Panel>()
        .tabs
        .iter()
        .position(|t| *t == Tool::Subagents)
    {
        close_tab(s, index, w, cx);
    }
    if selected == Tool::Subagents && !restore_panel(s, cx) {
        layout::focus(s, "panel-new-tab", w);
    }
}
