//! Pinned threads: a Pinned shelf at the top of the list, kept visible in
//! every view and above the Working section. Pins persist through the
//! server's inbox preferences (#5141), so the desktop and native sidebars
//! agree; order follows the server's pin order key, then pin time.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};

/// Lucide pin.
pub(crate) const PIN: &str = "M12 17v5 M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";

/// Pinned ids in display order: order key (unkeyed last), then pin time.
pub(crate) fn pinned_order(sessions: &[Session]) -> Vec<String> {
    let mut pinned: Vec<&Session> = sessions
        .iter()
        .filter(|s| s.pinned_at.is_some() && s.status != "archived")
        .collect();
    pinned.sort_by(|a, b| {
        (a.pin_order_key.is_none(), &a.pin_order_key, &a.pinned_at)
            .cmp(&(b.pin_order_key.is_none(), &b.pin_order_key, &b.pinned_at))
    });
    pinned.into_iter().map(|s| s.id.clone()).collect()
}

/// Lifts pinned thread rows (outside Archived) into a Pinned shelf at the
/// top and drops any section left empty behind them.
pub(crate) fn fold_pinned(rows: Vec<Row>, order: &[String]) -> Vec<Row> {
    if order.is_empty() {
        return rows;
    }
    let end = rows
        .iter()
        .position(|r| r.kind == "section" && r.title == "Archived")
        .unwrap_or(rows.len());
    let mut rows = rows;
    let tail = rows.split_off(end);
    let (mut pinned, rest): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| {
        r.kind == "thread" && r.id.as_ref().is_some_and(|id| order.contains(id))
    });
    if pinned.is_empty() {
        let mut rows = rest;
        rows.extend(tail);
        return rows;
    }
    pinned.sort_by_key(|r| order.iter().position(|id| Some(id) == r.id.as_ref()));
    let mut out = vec![recents::header("section", "Pinned", "pinned")];
    out.extend(pinned);
    // A heading whose threads all moved up no longer heads anything.
    let mut kept: Vec<Row> = Vec::with_capacity(rest.len() + tail.len());
    for row in rest.into_iter().chain(tail) {
        if matches!(row.kind.as_str(), "section" | "folder") && kept.last().is_some_and(heads_nothing) {
            kept.pop();
        }
        kept.push(row);
    }
    if kept.last().is_some_and(heads_nothing) {
        kept.pop();
    }
    out.extend(kept);
    out
}
/// An ordinary heading; Archived keeps its header even when closed, and
/// Recents heads the date groups that follow it.
fn heads_nothing(row: &Row) -> bool {
    row.kind == "section" && !matches!(row.title.as_str(), "Archived" | "Recents") && row.status != "pinned"
}

impl ThreadList {
    pub(super) fn pinned(&self, id: &str) -> bool {
        self.sessions.iter().any(|s| s.id == id && s.pinned_at.is_some())
    }
    pub(super) fn pinnable(&self, id: &str) -> Option<&Session> {
        self.sessions
            .iter()
            .find(|s| s.id == id && s.status != "archived" && s.inbox_subject.is_some())
    }
    pub(super) fn toggle_pin(&mut self, id: String, cx: &mut Context<Self>) {
        self.row_menu = None;
        let Some(session) = self.pinnable(&id) else { return };
        let pin = session.pinned_at.is_none();
        let (workspace, revision) = (session.repo_path.clone(), session.inbox_revision.unwrap_or(0));
        let client = self.client.clone();
        let target = id.clone();
        let task = cx.background_executor().spawn(async move {
            client.inbox_pin(workspace.as_deref(), &target, pin, revision)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(state) => {
                        if let Some(s) = this.sessions.iter_mut().find(|s| s.id == id) {
                            s.pinned_at = state["pinnedAt"].as_str().map(str::to_owned);
                            s.pin_order_key = state["pinOrderKey"].as_str().map(str::to_owned);
                            s.inbox_revision = state["inboxRevision"].as_u64();
                        }
                        // Fence an older listing so it cannot undo the pin.
                        this.generation += 1;
                        this.rebuild();
                        this.load(cx);
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    /// The row menu's Pin / Unpin.
    pub(super) fn pin_item(&self, id: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.pinnable(id)?;
        let text = if self.pinned(id) { "Unpin" } else { "Pin" };
        let id = id.to_owned();
        Some(
            div()
                .id("sidebar-row-pin")
                .debug_selector(|| "sidebar-row-pin".into())
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(7.))
                .text_size(px(12.5))
                .cursor_pointer()
                .hover(|s| s.bg(theme().hover))
                .child(crate::icon::stroke(PIN, theme().text_muted, 14., 1.7))
                .child(text)
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _, cx| this.toggle_pin(id.clone(), cx)))
                .into_any_element(),
        )
    }
    /// The small pin mark on a pinned row.
    pub(super) fn pin_mark(&self, id: &str) -> Option<AnyElement> {
        self.pinned(id).then(|| {
            let sid = id.to_owned();
            div()
                .debug_selector(move || format!("thread-pin-{sid}"))
                .flex_shrink_0()
                .child(crate::icon::stroke(PIN, theme().text_faint, 10., 2.))
                .into_any_element()
        })
    }
}
