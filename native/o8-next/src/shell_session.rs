//! Narrow embedding API. The shell uses the production Surface and composer.
use super::*;
impl Surface {
    #[cfg(test)]
    pub(crate) fn shell_loaded_probe(&mut self, load_older: bool, cx: &mut Context<Self>) -> Value {
        if load_older {
            self.load_older(cx);
        }
        let editor = self.composer.read(cx);
        json!({"rows":self.rows.len(), "text":editor.text, "revision":editor.revision,
            "painted":editor.painted, "regions":self.regions.renders(cx)})
    }
    pub(crate) fn shell_linked_issue(&self) -> Option<crate::issues::LinkedIssue> {
        self.selected
            .as_ref()
            .and_then(|id| self.linked_issues.get(id))
            .cloned()
    }
    #[cfg(test)]
    pub(crate) fn shell_issue_state(&self, cx: &App) -> Value {
        let brain = self.selected.as_ref().and_then(|id| self.brains.get(id));
        json!({"notice":self.notice,"ready":self.queue_ready,"canSteer":self.queue["canSteer"],"saving":self.saving,"draft":self.composer.read(cx).text,"selected":self.selected,"brainDraft":brain.map(|brain| brain.read(cx).composer.read(cx).text.clone())})
    }
    pub(crate) fn shell_link_issue(
        &mut self,
        issue: Option<crate::issues::LinkedIssue>,
        cx: &mut Context<Self>,
    ) {
        if let Some(id) = &self.selected {
            if let Some(issue) = issue {
                self.linked_issues.insert(id.clone(), issue);
            } else {
                self.linked_issues.remove(id);
            }
        }
        cx.notify();
    }
    pub(crate) fn shell_issue_task(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if self.saving || !self.queue_ready {
            return Err("Worker is loading or saving. Retry when its composer is ready.".into());
        }
        if !self.composer.read(cx).text.trim().is_empty()
            || self
                .selected
                .as_ref()
                .is_some_and(|id| self.pending.contains_key(id))
        {
            return Err(
                "Worker has a draft or an unconfirmed send. Finish it before launching issue work."
                    .into(),
            );
        }
        let issue = self
            .selected
            .as_ref()
            .and_then(|id| self.linked_issues.get(id))
            .ok_or("Link an issue first")?;
        let prompt = format!(
            "Work on GitHub issue #{} in {}: {}. Inspect the local repository and its readiness before coding; implement the smallest fix and validate through the real entry point.",
            issue.issue.number, issue.repo, issue.issue.title
        );
        self.composer.update(cx, |i, cx| i.set_text(&prompt, cx));
        self.composer.read(cx).focus.focus(window);
        self.send(None, cx);
        Ok(())
    }
    pub(crate) fn shell_new(
        client: Client,
        sessions: Vec<Session>,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut surface = Self::new(client, window, cx);
        surface.embedded = true;
        surface.sessions = sessions;
        surface.select(id, cx);
        surface
    }
    pub(crate) fn shell_select(
        &mut self,
        sessions: Vec<Session>,
        id: String,
        cx: &mut Context<Self>,
    ) {
        self.sessions = sessions;
        if self.selected.as_ref() != Some(&id) {
            self.select(id, cx);
        }
    }
    pub(crate) fn shell_tick(&mut self, refresh: bool, cx: &mut Context<Self>) {
        self.poll_stream(cx);
        if refresh {
            self.reconcile(cx);
        }
    }
    pub(crate) fn shell_refresh(&mut self, cx: &mut Context<Self>) {
        self.load_sessions(cx);
    }
    #[cfg(test)]
    pub(crate) fn shell_brain_view(&self) -> Option<gpui::Entity<crate::brain::Brain>> {
        self.selected
            .as_ref()
            .and_then(|id| self.brains.get(id))
            .cloned()
    }
    pub(crate) fn shell_open_brain(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(brain) = self.selected.as_ref().and_then(|id| self.brains.get(id))
            && brain.read(cx).expanded
        {
            brain.read(cx).focus(window, cx);
        } else {
            self.toggle_brain(window, cx);
        }
    }
    pub(crate) fn shell_open(&mut self, id: String, cx: &mut Context<Self>) {
        if self.selected.as_ref() != Some(&id) {
            self.select(id, cx);
        }
    }
    pub(crate) fn shell_focus(&self, composer: bool, window: &mut Window, cx: &App) {
        if composer {
            self.composer.read(cx).focus.focus(window);
            return;
        }
        if let Some(brain) = self.selected.as_ref().and_then(|id| self.brains.get(id))
            && brain.read(cx).expanded
        {
            brain.read(cx).focus(window, cx);
            return;
        }
        self.focus.focus(window);
    }
    /// Reading focus is distinct from any nested editor or terminal control.
    pub(crate) fn shell_reading_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }
    pub(crate) fn shell_selection(&self, window: &Window, cx: &App) -> (Option<String>, bool) {
        (
            self.selected.clone(),
            self.composer.read(cx).focus.is_focused(window),
        )
    }
    /// The conversation's tool steps, oldest first, and whether a turn is
    /// streaming, for the Activity Dock.
    pub(crate) fn shell_steps(&self) -> (Vec<crate::activity::Step>, bool) {
        let mut live = false;
        let steps = self
            .rows
            .iter()
            .flat_map(|row| match &row.borrow().row {
                Row::Activity { steps, trace, .. } => {
                    live |= trace.live;
                    steps.clone()
                }
                _ => vec![],
            })
            .collect();
        (steps, live)
    }
    #[cfg(test)]
    pub(crate) fn shell_selected(&self) -> String {
        self.selected.clone().unwrap()
    }
    #[cfg(test)]
    pub(crate) fn shell_ready(&self) -> bool {
        self.transcript.is_some() && !self.rows.is_empty() && !self.painted_rows.borrow().is_empty()
    }
}
