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

/// Pinned ids in display order: by effective order key (a pin without a
/// server key takes an implicit one from its pin time, after every
/// ordinary key), then pin time, then id.
pub(crate) fn pinned_order(sessions: &[Session]) -> Vec<String> {
    let mut pinned: Vec<&Session> = sessions
        .iter()
        .filter(|s| s.pinned_at.is_some() && s.status != "archived")
        .collect();
    pinned.sort_by_cached_key(|s| {
        (effective_key(s.pin_order_key.as_deref(), s.pinned_at.as_deref()), s.pinned_at.clone(), s.id.clone())
    });
    pinned.into_iter().map(|s| s.id.clone()).collect()
}

/// An unkeyed pin's implicit order key: `zz` then its pin time's digits as
/// letters `b`..`k` (fixed width), so unkeyed pins sort after keyed ones,
/// oldest first, exactly as before, and a single moved thread can take a
/// key between any two neighbours.
pub(crate) fn implicit_key(pinned_at: &str) -> String {
    let mut digits: Vec<u8> = pinned_at.bytes().filter(u8::is_ascii_digit).take(17).collect();
    digits.resize(17, b'0');
    let mut key = String::from("zz");
    key.extend(digits.into_iter().map(|d| char::from(b'b' + (d - b'0'))));
    key
}
pub(crate) fn effective_key(key: Option<&str>, pinned_at: Option<&str>) -> String {
    key.map(str::to_owned).unwrap_or_else(|| implicit_key(pinned_at.unwrap_or("")))
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

/// The single key write for a drop: the moved thread alone takes a key
/// between its new neighbours' effective keys (`keys` holds each pin's
/// effective key). None when the neighbours tie, so no key fits.
pub(crate) fn plan_key(order: &[String], keys: &HashMap<String, String>, moved: &str) -> Option<(String, String)> {
    let at = order.iter().position(|id| id == moved)?;
    let lo = at.checked_sub(1).and_then(|i| keys.get(&order[i]));
    let hi = order.get(at + 1).and_then(|id| keys.get(id));
    if let (Some(lo), Some(hi)) = (lo, hi) {
        if lo >= hi {
            return None;
        }
    }
    Some((moved.to_owned(), key_between(lo.map(String::as_str), hi.map(String::as_str))))
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
    /// Tracks where a pinned-row drag would land. Over a pinned row,
    /// `side` is None and the row's middle splits before / after; over a
    /// zone (the Pinned header, the gap down to the next heading) the side
    /// is fixed: first or last.
    pub(super) fn pin_drag_move(
        &mut self,
        target: &str,
        side: Option<bool>,
        event: &gpui::DragMoveEvent<PinDrag>,
        cx: &mut Context<Self>,
    ) {
        let (bounds, at) = (event.bounds, event.event.position);
        if side.is_none() {
            self.pin_bounds.insert(target.to_owned(), bounds);
        }
        if !bounds.contains(&at) {
            return;
        }
        let after = side.unwrap_or(at.y > bounds.center().y);
        let next = Some((target.to_owned(), after));
        if self.pin_drop != next {
            self.pin_drop = next;
            cx.notify();
        }
    }
    /// The list's empty space below a shelf that ends the list drops last.
    pub(super) fn pin_tail_move(&mut self, event: &gpui::DragMoveEvent<PinDrag>, cx: &mut Context<Self>) {
        let at = event.event.position;
        let order = pinned_order(&self.sessions);
        let shelf_ends = self.rows.last().and_then(|r| r.id.as_ref()).is_some_and(|id| order.contains(id));
        let bottom = self.pin_bounds.values().map(|b| b.bottom()).max();
        let Some(last) = order.last() else { return };
        if shelf_ends && event.bounds.contains(&at) && bottom.is_some_and(|b| at.y > b) {
            let next = Some((last.clone(), true));
            if self.pin_drop != next {
                self.pin_drop = next;
                cx.notify();
            }
        }
    }
    /// The drop zone a non-pin row offers: the Pinned header drops first;
    /// the heading right below the shelf drops last.
    pub(super) fn pin_zone(&self, i: usize) -> Option<(String, bool)> {
        let order = pinned_order(&self.sessions);
        let row = self.rows.get(i)?;
        if row.kind == "section" && row.status == "pinned" {
            return order.first().map(|id| (id.clone(), false));
        }
        let above = self.rows.get(i.checked_sub(1)?)?;
        let pinned_above = above.id.as_ref().is_some_and(|id| order.contains(id));
        let pinned_here = row.id.as_ref().is_some_and(|id| order.contains(id));
        if !pinned_above || pinned_here {
            return None;
        }
        order.last().map(|id| (id.clone(), true))
    }
    /// Drops a pinned row: optimistic order, then one pin-reorder write
    /// (#5141) for the moved thread only; a refusal (stale revision
    /// included) reverts and reloads.
    pub(super) fn drop_pin(&mut self, moved: &str, cx: &mut Context<Self>) {
        let Some((target, after)) = self.pin_drop.take() else { return cx.notify() };
        let order = pinned_order(&self.sessions);
        let Some(next) = reorder(&order, moved, &target, after) else { return cx.notify() };
        let keys: HashMap<String, String> = self
            .sessions
            .iter()
            .filter(|s| order.contains(&s.id))
            .map(|s| (s.id.clone(), effective_key(s.pin_order_key.as_deref(), s.pinned_at.as_deref())))
            .collect();
        let Some((_, key)) = plan_key(&next, &keys, moved) else {
            self.notice = "Those pins share a pin time; move another pin first.".into();
            return cx.notify();
        };
        let Some(s) = self.sessions.iter_mut().find(|s| s.id == moved) else { return };
        let previous = s.pin_order_key.replace(key.clone());
        let (workspace, revision) = (s.repo_path.clone(), s.inbox_revision.unwrap_or(0));
        self.generation += 1;
        self.rebuild();
        cx.notify();
        let client = self.client.clone();
        let id = moved.to_owned();
        let target = id.clone();
        let task = cx.background_executor().spawn(async move {
            client.inbox_preference(workspace.as_deref(), &target, "pin-reorder", Some(&key), revision)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                let session = this.sessions.iter_mut().find(|s| s.id == id);
                match (result, session) {
                    (Ok(state), Some(s)) => {
                        s.pin_order_key = state["pinOrderKey"].as_str().map(str::to_owned);
                        s.inbox_revision = state["inboxRevision"].as_u64();
                    }
                    (Err(error), Some(s)) => {
                        s.pin_order_key = previous;
                        this.notice = error;
                        this.rebuild();
                    }
                    _ => {}
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
