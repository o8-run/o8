//! Review map loading and navigation share the diff's revision boundary.
use super::*;

impl DiffSurface {
    pub(super) fn load_map(&mut self, generation: u64, cx: &mut Context<Self>) {
        let query = match &self.target {
            Target::Packet(id) => vec![("lane".into(), id.clone())],
            Target::Worktree {
                path,
                base: None,
                file: None,
            } => vec![("workspace".into(), path.clone())],
            _ => vec![],
        };
        if !query.is_empty() {
            let Some(query) = self
                .map
                .bind_revision(query, self.document.revision.as_deref())
            else {
                return;
            };
            let paths = self.document.files.iter().map(|f| f.path.clone()).collect();
            crate::change_map::ChangeMap::load(
                self.client.clone(),
                query,
                paths,
                cx,
                move |s, mut map, cx| {
                    if s.generation != generation {
                        return;
                    }
                    map.expanded = s.map.expanded;
                    s.map = map;
                    cx.notify();
                },
            );
        } else {
            self.map.error = Some("Change map unavailable for this comparison.".into());
        }
    }
    pub(super) fn change_map_view(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        self.map.view("diff-map", cx, |s, command, cx| {
            let navigate = matches!(
                command,
                crate::change_map::Command::Select(_) | crate::change_map::Command::Focus(_)
            );
            s.map.apply(&command);
            if navigate {
                s.set_scope(Scope::All, cx);
                if let Some(index) = s.shown().first().copied() {
                    s.pick(index, cx);
                }
            }
            cx.notify();
        })
    }
}
