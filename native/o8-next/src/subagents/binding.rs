use super::*;
impl Surface {
    pub(super) fn bind_subagent_scope(
        &mut self,
        session: Option<&Session>,
        cx: &mut Context<Self>,
    ) {
        let scope = session.and_then(|s| {
            Some(crate::subagents::model::Scope {
                repo: s.repo_path.clone()?,
                parent: Some(s.id.clone()),
            })
        });
        if self.subagents.as_ref().map(|v| &v.read(cx).scope) == scope.as_ref() {
            return;
        }
        self.subagent_observer = None;
        self.subagents = scope.map(|scope| {
            cx.new(|cx| crate::subagents::Inspector::new(self.client.clone(), scope, cx))
        });
        if let Some(view) = &self.subagents {
            self.subagent_observer = Some(cx.observe(view, |s, _, cx| s.attach_subagents(cx)));
        }
    }
    pub(super) fn attach_subagents(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.subagents.clone() else {
            return;
        };
        let agents = Rc::new(view.read(cx).agents.clone());
        for (index, row) in self.rows.iter().enumerate() {
            let mut row = row.borrow_mut();
            if !matches!(&row.row,Row::Activity{steps,..} if steps.iter().any(|s|!s.delegations.is_empty()))
            {
                continue;
            }
            if row.subagents.as_ref() != Some(&view) || *row.subagent_agents != *agents {
                row.subagents = Some(view.clone());
                row.subagent_agents = agents.clone();
                self.remeasure_action_row(index);
            }
        }
        cx.notify();
    }
    pub(crate) fn shell_subagents(&self) -> Option<gpui::Entity<crate::subagents::Inspector>> {
        self.subagents.clone()
    }
}
