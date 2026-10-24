//! Narrow embedding API. The shell uses the production Surface and composer.
use super::*;
impl Surface {
    pub(crate) fn shell_new(
        client: Client,
        sessions: Vec<Session>,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut surface = Self::new(client, window, cx);
        surface.sessions = sessions;
        surface.select(id, cx);
        surface
    }
    pub(crate) fn shell_tick(&mut self, refresh: bool, cx: &mut Context<Self>) {
        self.poll_stream(cx);
        if refresh {
            self.reconcile(cx);
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
        } else {
            self.focus.focus(window);
        }
    }
    pub(crate) fn shell_selection(&self, window: &Window, cx: &App) -> (Option<String>, bool) {
        (
            self.selected.clone(),
            self.composer.read(cx).focus.is_focused(window),
        )
    }
    #[cfg(test)]
    pub(crate) fn shell_ready(&self) -> bool {
        self.transcript.is_some() && !self.rows.is_empty() && !self.painted_rows.borrow().is_empty()
    }
}
