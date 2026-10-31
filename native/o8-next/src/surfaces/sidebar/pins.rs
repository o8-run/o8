//! Pinned threads: a Pinned shelf at the top of the list, kept visible in
//! every view and above the Working section. Pins persist through the
//! server's inbox preferences (#5141), so the desktop and native sidebars
//! agree; order follows the server's pin order key, then pin time.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::FluentBuilder, px};
use std::collections::HashMap;

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
                    Err(error) => {
                        this.notice = error;
                        // A stale revision heals on the next listing.
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

/// A fractional order key strictly between `lo` and `hi` in the server's
/// alphabet (`[a-z]+`, never ending in `a`), as #5141 validates.
pub(crate) fn key_between(lo: Option<&str>, hi: Option<&str>) -> String {
    let lo = lo.unwrap_or("").as_bytes();
    let hi = hi.map(str::as_bytes);
    let mut out = Vec::new();
    let mut bounded = hi.is_some();
    let mut i = 0;
    loop {
        let l = lo.get(i).map_or(0, |c| c - b'a');
        let h = if bounded { hi.unwrap().get(i).map_or(26, |c| c - b'a') } else { 26 };
        if h > l + 1 {
            out.push(b'a' + (l + h) / 2);
            return String::from_utf8(out).unwrap();
        }
        out.push(b'a' + l);
        if h == l + 1 {
            bounded = false;
        }
        i += 1;
    }
}

/// The pinned order after moving `moved` before (or after) `target`.
pub(crate) fn reorder(order: &[String], moved: &str, target: &str, after: bool) -> Option<Vec<String>> {
    if moved == target || !order.iter().any(|id| id == moved) {
        return None;
    }
    let mut next: Vec<String> = order.iter().filter(|id| *id != moved).cloned().collect();
    let at = next.iter().position(|id| id == target)? + usize::from(after);
    next.insert(at, moved.to_owned());
    (next != order).then_some(next)
}

/// The key writes that make `order` the server's order. One write for the
/// moved thread when its new neighbours are keyed apart; otherwise every
/// pin is rekeyed in order (unkeyed pins sort last, so they need keys too).
pub(crate) fn plan_keys(
    order: &[String],
    keys: &HashMap<String, Option<String>>,
    moved: &str,
) -> Vec<(String, String)> {
    let key = |id: &String| keys.get(id).cloned().flatten();
    let at = order.iter().position(|id| id == moved);
    let others_keyed = order.iter().filter(|id| *id != moved).all(|id| key(id).is_some());
    if let (Some(at), true) = (at, others_keyed) {
        let lo = at.checked_sub(1).and_then(|i| key(&order[i]));
        let hi = order.get(at + 1).and_then(key);
        if lo.is_none() || hi.is_none() || lo < hi {
            return vec![(moved.to_owned(), key_between(lo.as_deref(), hi.as_deref()))];
        }
    }
    let mut prev: Option<String> = None;
    let mut writes = Vec::new();
    for id in order {
        let k = key_between(prev.as_deref(), None);
        if key(id).as_deref() != Some(k.as_str()) {
            writes.push((id.clone(), k.clone()));
        }
        prev = Some(k);
    }
    writes
}

/// A dragged pinned row, drawn as a pill that follows the pointer.
#[derive(Clone)]
pub(crate) struct PinDrag {
    pub id: String,
    pub title: gpui::SharedString,
}
impl gpui::Render for PinDrag {
    fn render(&mut self, _: &mut gpui::Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        div()
            .debug_selector(|| "sidebar-pin-drag".into())
            .h(px(26.))
            .max_w(px(220.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(6.))
            .rounded(px(7.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .text_size(px(12.5))
            .text_color(theme().text)
            .opacity(0.92)
            .child(crate::icon::stroke(PIN, theme().text_muted, 12., 1.8))
            .child(div().overflow_hidden().whitespace_nowrap().text_ellipsis().child(self.title.clone()))
    }
}

impl ThreadList {
    /// Tracks where a pinned-row drag would land: before or after the
    /// pinned row under the pointer.
    pub(super) fn pin_drag_move(
        &mut self,
        target: &str,
        event: &gpui::DragMoveEvent<PinDrag>,
        cx: &mut Context<Self>,
    ) {
        let (bounds, y) = (event.bounds, event.event.position.y);
        if !bounds.contains(&event.event.position) {
            return;
        }
        let after = y > bounds.center().y;
        let next = Some((target.to_owned(), after));
        if self.pin_drop != next {
            self.pin_drop = next;
            cx.notify();
        }
    }
    /// Drops a pinned row: optimistic order, then the server's pin-reorder
    /// (#5141); a refusal (stale revision included) reverts and reloads.
    pub(super) fn drop_pin(&mut self, moved: &str, cx: &mut Context<Self>) {
        let Some((target, after)) = self.pin_drop.take() else { return cx.notify() };
        let order = pinned_order(&self.sessions);
        let Some(next) = reorder(&order, moved, &target, after) else { return cx.notify() };
        let keys: HashMap<String, Option<String>> = self
            .sessions
            .iter()
            .filter(|s| order.contains(&s.id))
            .map(|s| (s.id.clone(), s.pin_order_key.clone()))
            .collect();
        let writes = plan_keys(&next, &keys, moved);
        let mut jobs = Vec::new();
        for (id, key) in &writes {
            if let Some(s) = self.sessions.iter_mut().find(|s| &s.id == id) {
                jobs.push((s.repo_path.clone(), id.clone(), key.clone(), s.inbox_revision.unwrap_or(0)));
                s.pin_order_key = Some(key.clone());
            }
        }
        self.generation += 1;
        self.rebuild();
        cx.notify();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let mut done = Vec::new();
            for (workspace, id, key, revision) in jobs {
                match client.inbox_preference(workspace.as_deref(), &id, "pin-reorder", Some(&key), revision) {
                    Ok(state) => done.push((id, state)),
                    Err(error) => return (done, Some(error)),
                }
            }
            (done, None)
        });
        cx.spawn(async move |this, cx| {
            let (done, error) = task.await;
            let _ = this.update(cx, |this, cx| {
                for (id, state) in &done {
                    if let Some(s) = this.sessions.iter_mut().find(|s| &s.id == id) {
                        s.pin_order_key = state["pinOrderKey"].as_str().map(str::to_owned);
                        s.inbox_revision = state["inboxRevision"].as_u64();
                    }
                }
                if let Some(error) = error {
                    // Revert the unconfirmed writes; the listing heals the rest.
                    for s in this.sessions.iter_mut() {
                        if keys.contains_key(&s.id) && !done.iter().any(|(id, _)| id == &s.id) {
                            s.pin_order_key = keys[&s.id].clone();
                        }
                    }
                    this.notice = error;
                    this.rebuild();
                }
                this.generation += 1;
                this.load(cx);
                cx.notify();
            });
        })
        .detach();
    }
    /// The drop indicator: an accent line on the target row's edge.
    pub(super) fn pin_drop_line(&self, id: &str) -> Option<AnyElement> {
        let (target, after) = self.pin_drop.as_ref()?;
        (target == id).then(|| {
            div()
                .debug_selector(|| "sidebar-pin-drop-indicator".into())
                .absolute()
                .left(px(4.))
                .right(px(4.))
                .h(px(2.))
                .rounded(px(1.))
                .bg(theme().accent)
                .when(*after, |v| v.bottom(px(0.)))
                .when(!*after, |v| v.top(px(0.)))
                .into_any_element()
        })
    }
}
