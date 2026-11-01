use super::*;
use crate::subagents::{Inspector, model::Scope};
impl Grid {
    pub(super) fn bind_subagents(&mut self, cx: &mut Context<Self>) {
        let keys = self
            .panes
            .iter()
            .filter_map(|p| p.key.clone())
            .collect::<Vec<_>>();
        self.subagents.retain(|key, _| keys.contains(key));
        for key in keys {
            if !self.subagents.contains_key(&key) {
                let client = self.client.clone();
                let repo = self.options.workspace.clone();
                let parent = key.clone();
                let view = cx.new(|cx| {
                    Inspector::new(
                        client,
                        Scope {
                            repo,
                            parent: Some(parent),
                        },
                        cx,
                    )
                });
                let target = key.clone();
                let observer = cx.observe(&view, move |s, view, cx| {
                    let agents = std::rc::Rc::new(view.read(cx).agents.clone());
                    for pane in s
                        .panes
                        .iter_mut()
                        .filter(|p| p.key.as_ref() == Some(&target))
                    {
                        pane.attach_subagents(view.clone(), agents.clone());
                    }
                    cx.notify();
                });
                self.subagents.insert(key.clone(), (view, observer));
            }
            let view = self.subagents[&key].0.clone();
            let agents = std::rc::Rc::new(view.read(cx).agents.clone());
            for pane in self
                .panes
                .iter_mut()
                .filter(|p| p.key.as_ref() == Some(&key))
            {
                pane.attach_subagents(view.clone(), agents.clone());
            }
        }
    }
    pub(crate) fn shell_subagents(&self) -> Option<gpui::Entity<Inspector>> {
        let key = self.panes.get(self.layout.focus)?.key.as_ref()?;
        self.subagents.get(key).map(|v| v.0.clone())
    }
}
