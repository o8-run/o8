//! o8.md-specific shell wiring; Files tools keep their existing workspace keys.
use super::*;
pub(super) fn configure(
    s: &mut Shell,
    view: &gpui::Entity<crate::files_panel::FilesPanel>,
    cx: &mut Context<Shell>,
) {
    s.subscriptions.push(cx.subscribe(
        view,
        |s, _, prefs: &crate::files_panel::NotesPreferencesChanged, cx| {
            s.state.notes = prefs.0.clone().clean();
            s.persist();
            for view in s
                .features
                .get::<Panel>()
                .files
                .values()
                .cloned()
                .collect::<Vec<_>>()
            {
                view.update(cx, |view, cx| {
                    view.set_notes_preferences(prefs.0.clone(), cx)
                });
            }
            cx.notify();
        },
    ));
}
pub(super) fn cover(s: &Shell, cx: &mut Context<Shell>) {
    let Some(panel) = s.features.read::<Panel>() else {
        return;
    };
    let active =
        (panel.current() == Tool::Spec && panel.motion.is_open()).then(|| key(s, Tool::Spec));
    let workspace = s.state.selected.as_deref().unwrap_or("");
    for (key, view) in panel.files.clone() {
        view.update(cx, |view, cx| {
            view.set_spec_workspace(workspace, cx);
            view.set_spec_active(active.as_deref() == Some(&key), cx);
        });
    }
}
