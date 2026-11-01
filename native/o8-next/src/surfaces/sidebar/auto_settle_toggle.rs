//! A thread's own auto-settle switch, in the row menu, over the server's
//! per-thread opt-out (inboxAction `auto-settle`, `autoSettleDisabledAt`).
//! A thread with it off carries a small mark beside its age.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};

/// A check struck through: auto-settle is off for this thread.
pub(super) const AUTO_OFF: &str = "M20 6 9 17l-5-5 M4 4l16 16";

impl ThreadList {
    pub(crate) fn auto_settle_off(&self, id: &str) -> bool {
        self.sessions
            .iter()
            .any(|s| s.id == id && s.auto_settle_disabled_at.is_some())
    }
    /// The row menu's "Don't auto-settle" / "Allow auto-settle".
    pub(super) fn auto_settle_item(&self, id: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.pinnable(id)?;
        let text = if self.auto_settle_off(id) {
            "Allow auto-settle"
        } else {
            "Don't auto-settle"
        };
        let id = id.to_owned();
        Some(
            div()
                .id("sidebar-row-auto-settle")
                .debug_selector(|| "sidebar-row-auto-settle".into())
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(7.))
                .text_size(px(12.5))
                .cursor_pointer()
                .hover(|s| s.bg(theme().hover))
                .child(crate::icon::stroke(AUTO_OFF, theme().text_muted, 14., 1.7))
                .child(text)
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _, cx| this.toggle_auto_settle(id.clone(), cx)))
                .into_any_element(),
        )
    }
    pub(super) fn toggle_auto_settle(&mut self, id: String, cx: &mut Context<Self>) {
        self.row_menu = None;
        let Some(session) = self.pinnable(&id) else { return };
        let enabled = session.auto_settle_disabled_at.is_some();
        let (workspace, revision) = (session.repo_path.clone(), session.inbox_revision.unwrap_or(0));
        let client = self.client.clone();
        let target = id.clone();
        let task = cx.background_executor().spawn(async move {
            client.inbox_auto_settle(workspace.as_deref(), &target, enabled, revision)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(state) => {
                        if let Some(s) = this.sessions.iter_mut().find(|s| s.id == id) {
                            s.auto_settle_disabled_at =
                                state["autoSettleDisabledAt"].as_str().map(str::to_owned);
                            s.inbox_revision = state["inboxRevision"].as_u64();
                        }
                        this.generation += 1;
                        this.rebuild();
                        this.load(cx);
                    }
                    Err(error) => {
                        this.notice = error;
                        this.generation += 1;
                        this.load(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    /// The small mark on a row whose auto-settle is off.
    pub(super) fn auto_off_mark(&self, id: &str) -> Option<AnyElement> {
        self.auto_settle_off(id).then(|| {
            let sid = id.to_owned();
            div()
                .id(gpui::ElementId::Name(format!("thread-auto-off-{sid}").into()))
                .debug_selector(move || format!("thread-auto-off-{sid}"))
                .flex_shrink_0()
                .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Auto-settle is off".into())).into())
                .child(crate::icon::stroke(AUTO_OFF, theme().text_faint, 10., 2.))
                .into_any_element()
        })
    }
}
