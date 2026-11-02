//! Range selection and bulk actions on thread rows, after T3 Code's inbox
//! sidebar: Shift-click selects a range, Cmd/Ctrl-click toggles one row, and
//! right-clicking a picked row acts on all of them. Reimplemented; no code shared.
use super::*;
use super::inbox::Undo;
use crate::shell::toasts;
use crate::theme::current as theme;
use gpui::{AnyElement, Corner, Modifiers, MouseButton, anchored, deferred, div, px};

/// The ids from `anchor` to `target` in row order, both included.
pub(super) fn range(ids: &[&str], anchor: &str, target: &str) -> Vec<String> {
    let (Some(a), Some(b)) = (
        ids.iter().position(|id| *id == anchor),
        ids.iter().position(|id| *id == target),
    ) else {
        return vec![target.to_owned()];
    };
    ids[a.min(b)..=a.max(b)]
        .iter()
        .map(|id| (*id).to_owned())
        .collect()
}

impl ThreadList {
    /// True when the click changed the selection and must not open the thread.
    pub(super) fn pick(&mut self, id: &str, modifiers: Modifiers, cx: &mut Context<Self>) -> bool {
        let toggle = modifiers.platform || modifiers.control;
        if !modifiers.shift && !toggle {
            self.pick_anchor = Some(id.to_owned());
            if !self.picked.is_empty() {
                self.picked.clear();
                cx.notify();
            }
            return false;
        }
        if modifiers.shift {
            let anchor = self
                .pick_anchor
                .clone()
                .or_else(|| self.selected.clone())
                .unwrap_or_else(|| id.to_owned());
            let ids: Vec<&str> = self.rows.iter().filter_map(|r| r.id.as_deref()).collect();
            self.picked = range(&ids, &anchor, id).into_iter().collect();
        } else {
            self.pick_anchor = Some(id.to_owned());
            if !self.picked.remove(id) {
                self.picked.insert(id.to_owned());
            }
        }
        cx.notify();
        true
    }
    fn take_picked(&mut self) -> Vec<String> {
        let ids = self.picked.drain().collect();
        self.pick_anchor = None;
        ids
    }
    /// Moves off the current thread when it just left the list.
    fn advance_past(&mut self, ids: &[String], index: Option<usize>, cx: &mut Context<Self>) {
        if self.selected.as_ref().is_some_and(|id| ids.contains(id))
            && let Some(next) = self.next_active(index)
            && !ids.contains(&next)
        {
            self.choose(next, cx);
        }
    }
    fn bulk_settle(&mut self, cx: &mut Context<Self>) {
        let ids = self.take_picked();
        let targets: Vec<_> = ids
            .iter()
            .filter_map(|id| {
                self.settleable(id)
                    .filter(|s| !s.settled())
                    .map(|s| (id.clone(), s.repo_path.clone()))
            })
            .collect();
        if targets.is_empty() {
            cx.notify();
            return;
        }
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            targets
                .into_iter()
                .map(|(id, repo)| {
                    let state = client.inbox_action(repo.as_deref(), &id, "settle");
                    (id, state)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let results = task.await;
            let _ = this.update(cx, |this, cx| this.bulk_settled(results, cx));
        })
        .detach();
    }
    fn bulk_settled(
        &mut self,
        results: Vec<(String, Result<Value, String>)>,
        cx: &mut Context<Self>,
    ) {
        let index = self
            .selected
            .as_ref()
            .and_then(|id| self.rows.iter().position(|r| r.id.as_ref() == Some(id)));
        let mut done = Vec::new();
        for (id, result) in results {
            match result {
                Ok(state) => {
                    if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                        session.settled_override =
                            state["settledOverride"].as_str().map(str::to_owned);
                        session.settled_at = state["settledAt"].as_str().map(str::to_owned);
                        session.auto_settled_reason =
                            state["autoSettledReason"].as_str().map(str::to_owned);
                        if let Some(revision) = state["inboxRevision"].as_u64() {
                            session.inbox_revision = Some(revision);
                        }
                    }
                    done.push(id);
                }
                Err(error) => self.notice = error,
            }
        }
        self.generation += 1;
        self.rebuild();
        self.advance_past(&done, index, cx);
        if !done.is_empty() {
            if let Some(undo) = self.undo.take() {
                toasts::dismiss(undo.toast, cx);
            }
            let list = cx.entity().downgrade();
            let target = done.clone();
            let action = toasts::Action::new("Undo", move |_, cx| {
                let _ = list.update(cx, |this, cx| {
                    this.undo = None;
                    this.undo_ids(target, cx);
                });
            });
            let count = done.len();
            let label = format!("Settled {count} thread{}", if count == 1 { "" } else { "s" });
            let toast = toasts::show(
                toasts::Kind::Info,
                label,
                vec![action],
                Some(toasts::NOTICE_TIMEOUT),
                cx,
            );
            self.undo = Some(Undo { ids: done, toast });
        }
        self.load(cx);
        cx.notify();
    }
    fn bulk_snooze(&mut self, until: u64, cx: &mut Context<Self>) {
        let index = self
            .selected
            .as_ref()
            .and_then(|id| self.rows.iter().position(|r| r.id.as_ref() == Some(id)));
        let ids: Vec<_> = self
            .take_picked()
            .into_iter()
            .filter(|id| self.snoozable(id))
            .collect();
        for id in &ids {
            self.snoozes.insert(id.clone(), until);
        }
        self.save_snoozes(cx);
        self.rebuild();
        self.advance_past(&ids, index, cx);
        cx.notify();
    }
    fn bulk_archive(&mut self, cx: &mut Context<Self>) {
        let date = iso_timestamp(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        );
        let targets: Vec<_> = self
            .take_picked()
            .into_iter()
            .filter(|id| !id.contains(':'))
            .filter_map(|id| {
                let session = self.sessions.iter().find(|s| s.id == id)?;
                (session.status != "archived").then(|| (id, session.repo_path.clone()))
            })
            .collect();
        self.generation += 1;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            targets
                .iter()
                .filter(|(id, repo)| {
                    client
                        .mutate_sidebar(repo.as_deref(), id, json!({"archivedAt":date}))
                        .is_ok()
                })
                .count()
        });
        cx.spawn(async move |this, cx| {
            let count = task.await;
            let _ = this.update(cx, |this, cx| {
                if count > 0 {
                    let label =
                        format!("Archived {count} thread{}", if count == 1 { "" } else { "s" });
                    toasts::show(
                        toasts::Kind::Chat,
                        label,
                        vec![],
                        Some(toasts::CHAT_TIMEOUT),
                        cx,
                    );
                }
                this.load(cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn bulk_retitle(&mut self, cx: &mut Context<Self>) {
        let targets: Vec<_> = self
            .take_picked()
            .into_iter()
            .filter(|id| !id.contains(':'))
            .filter_map(|id| {
                let session = self.sessions.iter().find(|s| s.id == id)?;
                Some((id, session.repo_path.clone()))
            })
            .collect();
        self.generation += 1;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            for (id, repo) in &targets {
                let _ = client.mutate_sidebar(repo.as_deref(), id, json!({"regenerateTitle":true}));
            }
        });
        cx.spawn(async move |this, cx| {
            task.await;
            let _ = this.update(cx, |this, cx| {
                this.load(cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn bulk_mark_unread(&mut self, cx: &mut Context<Self>) {
        let ids = self.take_picked();
        for session in &mut self.sessions {
            if ids.contains(&session.id) && self.selected.as_ref() != Some(&session.id) {
                session.unread = true;
            }
        }
        self.rebuild();
        cx.notify();
    }
    fn bulk_item(
        selector: String,
        label: String,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> AnyElement {
        div()
            .id(gpui::ElementId::Name(selector.clone().into()))
            .debug_selector(move || selector.clone())
            .h(px(28.))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(7.))
            .text_size(px(12.5))
            .cursor_pointer()
            .hover(|s| s.bg(theme().hover))
            .child(label)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, _, _, cx| {
                this.row_menu = None;
                run(this, cx);
            }))
            .into_any_element()
    }
    /// The row menu for a right-click on a picked row: every action names how
    /// many threads it touches, as T3 Code's does.
    pub(super) fn bulk_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let position = self.row_menu.as_ref()?.position;
        let count = self.picked.len();
        let mut items = vec![Self::bulk_item(
            "sidebar-bulk-settle".into(),
            format!("Settle ({count})"),
            cx,
            |this, cx| this.bulk_settle(cx),
        )];
        for (index, (label, until)) in snooze::presets(recents::now()).into_iter().enumerate() {
            items.push(Self::bulk_item(
                format!("sidebar-bulk-snooze-{index}"),
                format!("Snooze ({count}) · {label}"),
                cx,
                move |this, cx| this.bulk_snooze(until, cx),
            ));
        }
        items.push(Self::bulk_item(
            "sidebar-bulk-retitle".into(),
            format!("Regenerate titles ({count})"),
            cx,
            |this, cx| this.bulk_retitle(cx),
        ));
        items.push(Self::bulk_item(
            "sidebar-bulk-unread".into(),
            format!("Mark unread ({count})"),
            cx,
            |this, cx| this.bulk_mark_unread(cx),
        ));
        items.push(Self::bulk_item(
            "sidebar-bulk-archive".into(),
            format!("Archive ({count})"),
            cx,
            |this, cx| this.bulk_archive(cx),
        ));
        Some(
            deferred(
                anchored()
                    .position(position)
                    .anchor(Corner::TopLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("sidebar-bulk-menu")
                            .debug_selector(|| "sidebar-bulk-menu".into())
                            .occlude()
                            .min_w(px(180.))
                            .rounded(px(12.))
                            .p(px(5.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                this.row_menu = None;
                                cx.notify();
                            }))
                            .children(items),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::range;

    #[test]
    fn a_range_runs_either_way_and_falls_back_to_the_target() {
        let ids = ["a", "b", "c", "d"];
        assert_eq!(range(&ids, "b", "d"), ["b", "c", "d"]);
        assert_eq!(range(&ids, "d", "b"), ["b", "c", "d"]);
        assert_eq!(range(&ids, "gone", "c"), ["c"]);
    }
}
