//! Experimental native canvas. The surface owns layout; card bodies stay native views.
use super::*;
use std::time::Instant;
#[path = "canvas/geometry.rs"]
pub(crate) mod geometry;
#[path = "canvas/model.rs"]
pub(crate) mod model;
#[path = "canvas/view.rs"]
mod view;
use self::view::Saved;
pub(super) use self::view::View;
#[cfg(test)]
#[path = "canvas/tests.rs"]
mod tests;

pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    enabled: bool,
    loading: bool,
    generation: u64,
    checked: Option<Instant>,
    views: HashMap<String, Entity<View>>,
}
struct Gate;
impl registry::ShellExtension for Gate {
    fn prepare(&self, s: &mut Shell, _: &mut Window, cx: &mut Context<Shell>) {
        if let Some(Tab::Canvas) = s.active() {
            let workspace = s.state.selected.as_deref().unwrap_or("");
            let desired = s.surfaces.canvas.views.get(&project_key(s, workspace));
            let content_key = s.key(&Tab::Canvas);
            let same = match (s.content.get(&content_key), desired) {
                (Some(Content::Canvas(current)), Some(desired)) => current == desired,
                _ => false,
            };
            if !same {
                s.content.remove(&content_key);
            } else if let Some(Content::Canvas(view)) = s.content.get(&content_key) {
                let view = view.clone();
                let client = s.panel_client(workspace);
                let path = session::workspace_path(workspace).to_owned();
                view.update(cx, |v, cx| v.workspace(client, path, cx));
            }
        }
    }
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((5, || Command::Canvas)),
    available: enabled,
    extension: Some(&Gate),
    create: |s, _, workspace, window, cx| {
        if !enabled(s) {
            return None;
        }
        let key = project_key(s, &workspace);
        if let Some(view) = s.surfaces.canvas.views.get(&key) {
            return Some(Content::Canvas(view.clone()));
        }
        let layout = s
            .state
            .canvas_layouts
            .get(&key)
            .cloned()
            .unwrap_or_default();
        let client = s.panel_client(&workspace);
        let view = cx.new(|cx| {
            View::new(
                client,
                session::workspace_path(&workspace).to_owned(),
                layout,
                cx,
            )
        });
        s.subscriptions.push(
            cx.subscribe_in(&view, window, move |s, _, event: &Saved, _, _| {
                s.state.canvas_layouts.insert(key.clone(), event.0.clone());
                s.persist();
            }),
        );
        s.surfaces
            .canvas
            .views
            .insert(project_key(s, &workspace), view.clone());
        Some(Content::Canvas(view))
    },
    // Read the preference once; the canvas_mode toggle applies its own change.
    // Only an open Canvas polls, so a change made elsewhere still closes it.
    initialize: |s, _, cx| refresh_setting(s, cx),
    tick: |s, _, cx| {
        if matches!(s.active(), Some(Tab::Canvas))
            && s.surfaces
                .canvas
                .checked
                .is_none_or(|t| t.elapsed() >= Duration::from_secs(2))
        {
            refresh_setting(s, cx);
        }
    },
    ..Registration::new("Canvas", "Open Canvas", |s, _, _, _| {
        enabled(s).then_some((Tab::Canvas, false))
    })
};
pub(super) fn enabled(s: &Shell) -> bool {
    s.surfaces.canvas.enabled
}
/// Whether the start-up preference read has answered.
#[cfg(test)]
pub(super) fn setting_read(s: &Shell) -> bool {
    s.surfaces.canvas.checked.is_some() && !s.surfaces.canvas.loading
}
fn project_key(s: &Shell, workspace: &str) -> String {
    let project = match s.sidebar_project_id() {
        Some(id) => (!id.is_empty() && id != "default" && !id.starts_with("repo:")).then_some(id),
        None => s.surfaces.settings.project.as_deref(),
    };
    if session::machine_workspace(workspace).is_none()
        && !session::is_home(workspace)
        && let Some(project) = project
    {
        return format!("project:{project}");
    }
    format!("workspace:{workspace}")
}
pub(super) fn active(s: &Shell) -> Option<Entity<View>> {
    if !enabled(s) {
        return None;
    }
    match s.active().and_then(|t| s.content.get(&s.key(&t))) {
        Some(Content::Canvas(v)) => Some(v.clone()),
        _ => None,
    }
}
pub(super) fn refresh_setting(s: &mut Shell, cx: &mut Context<Shell>) {
    if s.surfaces.canvas.loading {
        return;
    }
    s.surfaces.canvas.loading = true;
    s.surfaces.canvas.generation += 1;
    let generation = s.surfaces.canvas.generation;
    s.surfaces.canvas.checked = Some(Instant::now());
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        client.get::<serde_json::Value>("/api/panel/operator-defaults", &[("include", "values")])
    });
    cx.spawn(async move |this, cx| {
        let value = task.await;
        let _ = this.update(cx, |s, cx| {
            if s.surfaces.canvas.generation != generation {
                return;
            }
            s.surfaces.canvas.loading = false;
            // Start closed; a transient refresh failure retains the last
            // resolved preference, like the shell's retained content.
            if let Ok(value) = value {
                apply_setting(s, value["values"]["experimentalCanvas"] == true, cx);
            }
        });
    })
    .detach();
}
pub(super) fn apply_setting(s: &mut Shell, enabled: bool, cx: &mut Context<Shell>) {
    s.surfaces.canvas.generation += 1;
    s.surfaces.canvas.loading = false;
    s.surfaces.canvas.checked = Some(Instant::now());
    s.surfaces.canvas.enabled = enabled;
    if !enabled {
        let mut changed = false;
        for workspace in s.state.workspaces.values_mut() {
            let active = workspace.tabs.get(workspace.active).cloned();
            let count = workspace.tabs.len();
            workspace.tabs.retain(|t| !matches!(t, Tab::Canvas));
            if count != workspace.tabs.len() {
                changed = true;
                workspace.active = active
                    .and_then(|t| workspace.tabs.iter().position(|v| v == &t))
                    .unwrap_or(0);
            }
        }
        s.content.retain(|_, v| !matches!(v, Content::Canvas(_)));
        s.surfaces.canvas.views.clear();
        if changed {
            s.persist();
        }
    }
    cx.notify();
}
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        let view = view.read(cx);
        if let Some(diff) = view
            .layout
            .diff
            .last()
            .and_then(|c| view.diffs.get(&c.lane_id))
        {
            diff.read(cx).focus(window);
        } else {
            view.focus.focus(window);
        }
    }
    fn refresh(view: &Entity<Self>, cx: &mut Context<Shell>) {
        view.update(cx, |v, cx| {
            v.load(cx);
            for diff in v.diffs.values() {
                diff.update(cx, |diff, cx| diff.load(cx));
            }
        });
    }
    #[cfg(test)]
    fn ready(_: &Entity<Self>, _: &App) -> bool {
        true
    }
}
