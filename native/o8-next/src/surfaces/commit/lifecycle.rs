//! Draft lifetime policy owned by this surface; no shared shell policy.
use super::*;
use gpui::{Keystroke, Modifiers, Subscription};
use std::collections::BTreeMap;

const CLOSE_QUERY: &str = "o8-next-window-close-query";

#[derive(Default)]
pub(crate) struct Runtime {
    views: BTreeMap<String, Entity<View>>,
    observer: Option<Subscription>,
    active_draft: Option<String>,
    focused: Option<FocusHandle>,
}
pub(super) fn has_draft(s: &Shell, cx: &App) -> bool {
    s.surfaces
        .commit
        .views
        .values()
        .any(|view| view.read(cx).has_draft(cx))
}
pub(super) fn close_query(event: &KeyDownEvent) -> bool {
    event.keystroke.key == CLOSE_QUERY
}
pub(super) fn veto_close(s: &mut Shell, cx: &mut Context<Shell>) -> bool {
    if !has_draft(s, cx) {
        return false;
    }
    s.notice = "Unsaved changes. Save or discard in the editor.".into();
    cx.notify();
    true
}
pub(super) fn remember(s: &mut Shell, workspace: String, view: Entity<View>) {
    s.surfaces.commit.views.insert(workspace, view);
}
pub(super) fn forget(s: &mut Shell, workspace: &str) {
    s.surfaces.commit.views.remove(workspace);
    if s.surfaces.commit.active_draft.as_deref() == Some(workspace) {
        s.surfaces.commit.active_draft = None;
        s.surfaces.commit.focused = None;
    }
}
pub(super) fn capture(s: &mut Shell, window: &Window, cx: &App) {
    if matches!(s.active(), Some(Tab::Commit))
        && let Some(workspace) = &s.state.selected
        && s.surfaces
            .commit
            .views
            .get(workspace)
            .is_some_and(|view| view.read(cx).has_draft(cx))
    {
        s.surfaces.commit.active_draft = Some(workspace.clone());
        s.surfaces.commit.focused = window.focused(cx);
    }
}
pub(super) fn install(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.surfaces.commit.observer.is_some() {
        return;
    }
    let shell = cx.entity();
    s.surfaces.commit.observer = Some(cx.observe_in(&shell, window, |s, _, window, cx| {
        recover(s, window, cx);
    }));
    let weak = cx.weak_entity();
    window.on_window_should_close(cx, move |window, cx| {
        weak.update(cx, |s, cx| {
            // Broadcast a private close query through the existing registered callback.
            // It never enters keyboard dispatch; independently registered editors can
            // veto the same window close without importing one another's modules.
            let query = KeyDownEvent {
                keystroke: Keystroke {
                    modifiers: Modifiers::default(),
                    key: CLOSE_QUERY.into(),
                    key_char: None,
                },
                is_held: false,
            };
            if registrations()
                .iter()
                .any(|r| (r.key_down)(s, &query, window, cx))
            {
                return false;
            }
            s.capture(window, cx);
            s.persist();
            true
        })
        .unwrap_or(false)
    });
}
fn recover(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let views: Vec<_> = s
        .surfaces
        .commit
        .views
        .iter()
        .map(|(workspace, view)| (workspace.clone(), view.clone()))
        .collect();
    let active = s.surfaces.commit.active_draft.clone();
    let mut changed = false;
    let mut recovered_active = false;
    for (workspace, view) in views {
        let key = format!("{}|{:?}", workspace, Tab::Commit);
        if !view.read(cx).has_draft(cx) {
            if !s.content.contains_key(&key) {
                s.surfaces.commit.views.remove(&workspace);
            }
            continue;
        }
        let missing = !s.content.contains_key(&key);
        if missing {
            s.content.insert(key, Content::Commit(view));
            changed = true;
        }
        let saved = s.state.workspaces.entry(workspace.clone()).or_default();
        if !saved.tabs.contains(&Tab::Commit) {
            saved.tabs.push(Tab::Commit);
            changed = true;
        }
        if !s.workspaces.contains(&workspace) {
            s.workspaces.push(workspace.clone());
            changed = true;
        }
        if missing
            && active.as_ref() == Some(&workspace)
            && (s.state.selected.is_none() || s.state.selected.as_ref() == Some(&workspace))
        {
            saved.active = saved
                .tabs
                .iter()
                .position(|tab| *tab == Tab::Commit)
                .unwrap();
            s.state.selected = Some(workspace);
            recovered_active = true;
        }
    }
    if changed {
        if recovered_active && !s.palette && !registrations().iter().any(|r| (r.overlay_open)(s)) {
            if s.state.selected == active
                && let Some(focused) = &s.surfaces.commit.focused
            {
                focused.focus(window);
            } else {
                s.restore_focus(window, cx);
            }
        }
        s.persist();
        s.revision += 1;
        cx.notify();
    }
}
