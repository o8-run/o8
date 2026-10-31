//! The Inbox view: Active and Settled sections over the server's inbox
//! settlement (docs/internals/inbox-settlement.md), with Settle and Un-settle
//! on the row and on Mod+Shift+S, park-and-advance and an Undo toast.
//!
//! Adapted from T3 Code (https://github.com/pingdotgg/t3code),
//! apps/web/src/components/Sidebar.tsx (settleAndAdvance, the Settled shelf),
//! apps/web/src/components/sidebar/SidebarThreadRow.tsx (Settle thread,
//! Un-settle thread) and apps/web/src/hooks/showThreadUndoNotice.ts, commit
//! f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
//! MIT; full notice retained in src/lib/usage/history-readers/LICENSE.txt.
//! Adaptations: Rust and GPUI, o8 words; Pinned, Working and Later arrive with
//! their server slices.
use super::*;
use crate::shell::toasts;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};

/// The last Settle and its toast, which offers Undo until a newer Settle or
/// its timeout.
pub(super) struct Undo {
    id: String,
    toast: toasts::ToastId,
}

/// Active, then Settled newest first, then Archived. A child worker stays
/// out: its parent conversation is listed and carries its state.
pub(super) fn rows(
    sessions: &[Session],
    query: &str,
    matches: &HashSet<String>,
    expanded: &HashSet<String>,
    branches: &HashSet<String>,
    snoozes: &HashMap<String, u64>,
) -> Vec<Row> {
    let now = recents::now();
    let searching = !query.trim().is_empty();
    let (live, archived): (Vec<_>, Vec<_>) = recents::visible(sessions, query, matches)
        .into_iter()
        .filter(|s| s.parent_inbox_subject.is_none())
        .partition(|s| s.status != "archived");
    let (mut settled, active): (Vec<_>, Vec<_>) = live.into_iter().partition(|s| s.settled());
    settled.sort_by(|a, b| b.settled_at.cmp(&a.settled_at));
    // A snooze hides an Active thread until its time; then it comes back on
    // top, under the threads waiting on you, until it is opened.
    let (mut snoozed, mut active): (Vec<_>, Vec<_>) = active
        .into_iter()
        .partition(|s| snoozes.get(&s.id).is_some_and(|until| *until > now));
    snoozed.sort_by_key(|s| snoozes[&s.id]);
    let woken = |s: &Session| snoozes.contains_key(&s.id);
    active.sort_by_key(|s| (!needs_input(s), !woken(s)));
    // Active always heads the list; its row carries the view picker.
    let mut rows = vec![recents::header("section", "Active", "")];
    let open = searching || expanded.contains("Active");
    let count = if open {
        active.len()
    } else {
        active.len().min(50)
    };
    rows.extend(active.iter().take(count).map(|s| {
        let mut row = recents::thread_row(s, now, branches);
        row.marker = if needs_input(s) {
            "input"
        } else if woken(s) {
            "back"
        } else {
            ""
        };
        row
    }));
    if count < active.len() {
        rows.push(recents::header(
            "more",
            &format!("Show {} more", active.len() - count),
            "Active",
        ));
    }
    let open = searching || expanded.contains("Snoozed");
    let at = rows.len();
    recents::group_rows(&mut rows, "Snoozed", &snoozed, 10, open, now, branches);
    // A snoozed row reads when it comes back in place of its age.
    for row in &mut rows[at..] {
        if let Some(until) = row.id.as_ref().and_then(|id| snoozes.get(id)) {
            row.age = snooze::until_label(*until, now);
        }
    }
    let open = searching || expanded.contains("Settled");
    recents::group_rows(&mut rows, "Settled", &settled, 10, open, now, branches);
    let open = searching || expanded.contains("Archived");
    recents::group_rows(&mut rows, "Archived", &archived, 12, open, now, branches);
    rows
}

/// A thread waiting on the user: a question or an approval.
pub(super) fn needs_input(s: &Session) -> bool {
    sidebar::rank(s) == 3 || s.status.trim().eq_ignore_ascii_case("approval")
}

impl ThreadList {
    /// Settle applies in the Inbox view on a host that projects settlement.
    pub(super) fn settleable(&self, id: &str) -> Option<&Session> {
        (self.view() == folders::View::Inbox)
            .then(|| {
                self.sessions
                    .iter()
                    .find(|s| s.id == id && s.status != "archived" && s.inbox_subject.is_some())
            })
            .flatten()
    }
    /// Older hosts project no inbox fields, and the menu offers no Inbox.
    pub(super) fn inbox_ready(&self) -> bool {
        self.sessions.iter().any(|s| s.inbox_subject.is_some())
    }
    /// Mod+Shift+S settles the current thread, or un-settles a settled one.
    pub(crate) fn settle_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let stroke = &event.keystroke;
        let secondary = if cfg!(target_os = "macos") {
            stroke.modifiers.platform
        } else {
            stroke.modifiers.control
        };
        if !(secondary && stroke.modifiers.shift && !stroke.modifiers.alt && stroke.key == "s") {
            return false;
        }
        let Some(id) = self
            .selected
            .clone()
            .filter(|id| self.settleable(id).is_some())
        else {
            return false;
        };
        self.settle_id(id, cx);
        true
    }
    /// Mod+Z, right after a Settle, un-settles it as the toast's Undo does.
    /// It applies only while the sidebar or nothing holds focus, so an
    /// editor's own undo is untouched.
    pub(crate) fn undo_key(
        &mut self,
        event: &KeyDownEvent,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let stroke = &event.keystroke;
        let secondary = if cfg!(target_os = "macos") {
            stroke.modifiers.platform
        } else {
            stroke.modifiers.control
        };
        if !(secondary && !stroke.modifiers.shift && !stroke.modifiers.alt && stroke.key == "z")
            || self.editing
        {
            return false;
        }
        let sidebar = window.focused(cx).is_none_or(|focused| {
            focused == self.focus || focused == self.archived_focus
        });
        let Some(undo) = self.undo.take_if(|_| sidebar) else {
            return false;
        };
        toasts::dismiss(undo.toast, cx);
        self.settle_id(undo.id, cx);
        true
    }
    pub(super) fn settle_id(&mut self, id: String, cx: &mut Context<Self>) {
        if self.settling.is_some() {
            return;
        }
        let Some(session) = self.settleable(&id) else {
            return;
        };
        let action = if session.settled() {
            "unsettle"
        } else {
            "settle"
        };
        let workspace = session.repo_path.clone();
        self.settling = Some(id.clone());
        self.notice.clear();
        let client = self.client.clone();
        let target = id.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.inbox_action(workspace.as_deref(), &target, action) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.settling = None;
                match result {
                    Ok(state) => this.settled(id, action, &state, cx),
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn settled(&mut self, id: String, action: &str, state: &Value, cx: &mut Context<Self>) {
        let index = self.rows.iter().position(|r| r.id.as_ref() == Some(&id));
        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
            session.settled_override = state["settledOverride"].as_str().map(str::to_owned);
            session.settled_at = state["settledAt"].as_str().map(str::to_owned);
        }
        // A listing already in flight predates this answer; fence it, as
        // archive and rename do, so it cannot put the row back.
        self.generation += 1;
        self.rebuild();
        if action == "settle" {
            // settleAndAdvance: only a thread that is still current moves on.
            if self.selected.as_ref() == Some(&id)
                && let Some(next) = self.next_active(index)
            {
                self.choose(next, cx);
            }
            if let Some(undo) = self.undo.take() {
                toasts::dismiss(undo.toast, cx);
            }
            let list = cx.entity().downgrade();
            let target = id.clone();
            let undo = toasts::Action::new("Undo", move |_, cx| {
                let _ = list.update(cx, |this, cx| {
                    this.undo = None;
                    this.settle_id(target, cx);
                });
            });
            let toast = toasts::show(
                toasts::Kind::Info,
                "Settled 1 thread",
                vec![undo],
                Some(toasts::NOTICE_TIMEOUT),
                cx,
            );
            self.undo = Some(Undo { id, toast });
        } else if self.undo.as_ref().is_some_and(|undo| undo.id == id)
            && let Some(undo) = self.undo.take()
        {
            toasts::dismiss(undo.toast, cx);
        }
        self.load(cx);
    }
    /// The Active thread now in the settled row's place, else the one above.
    pub(super) fn next_active(&self, index: Option<usize>) -> Option<String> {
        let index = index?;
        let end = self
            .rows
            .iter()
            .skip(1)
            .position(|r| r.kind == "section")
            .map_or(self.rows.len(), |at| at + 1);
        let active: Vec<_> = self.rows[..end]
            .iter()
            .enumerate()
            .filter_map(|(i, r)| r.id.clone().map(|id| (i, id)))
            .collect();
        active
            .iter()
            .find(|(i, _)| *i >= index)
            .or(active.last())
            .map(|(_, id)| id.clone())
    }
    pub(super) fn row_settle_control(
        &self,
        row: &Row,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = row.id.clone()?;
        let settled = self.settleable(&id)?.settled();
        let selector = id.clone();
        let tip = if settled {
            "Un-settle thread"
        } else {
            "Settle thread"
        };
        Some(
            div()
                .id(gpui::ElementId::Name(format!("settle:{id}").into()))
                .debug_selector(move || format!("thread-settle-{selector}"))
                .size(px(18.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .when(
                    !settled && (!keyboard || self.choice.as_ref() != Some(&id)),
                    |v| v.invisible().group_hover("thread-row", |s| s.visible()),
                )
                .opacity(if self.settling.is_some() { 0.5 } else { 1. })
                .cursor_pointer()
                .hover(|v| v.bg(theme().hover))
                .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
                .child(crate::icon::stroke(
                    folders::CHECK,
                    if settled {
                        theme().accent
                    } else {
                        theme().text_muted
                    },
                    11.,
                    2.6,
                ))
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    // Keeps Mod+Z with the list for the Undo that follows.
                    this.focus.focus(window);
                    this.settle_id(id.clone(), cx);
                }))
                .into_any_element(),
        )
    }
    /// The Settled toast still offering Undo.
    #[cfg(test)]
    pub(crate) fn undo_toast(&self) -> Option<toasts::ToastId> {
        self.undo.as_ref().map(|undo| undo.toast)
    }
}
