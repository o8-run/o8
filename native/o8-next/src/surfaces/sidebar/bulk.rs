//! Range selection and bulk actions on thread rows, after T3 Code's inbox
//! sidebar: Shift-click selects a range, Cmd/Ctrl-click toggles one row, and a
//! bar under the list acts on all of them. Reimplemented; no code shared.
use super::*;
use super::inbox::Undo;
use crate::shell::toasts;
use crate::theme::current as theme;
use gpui::{AnyElement, Modifiers, MouseButton, div, px};

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
    fn bulk_button(
        selector: &'static str,
        label: &'static str,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        div()
            .id(selector)
            .debug_selector(move || selector.into())
            .h(px(24.))
            .px(px(7.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .text_size(px(12.))
            .cursor_pointer()
            .hover(|s| s.bg(theme().hover))
            .child(label)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, _, _, cx| run(this, cx)))
    }
    /// The action bar under the list while two or more rows are picked.
    pub(super) fn bulk_bar(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let count = self.picked.len();
        if count < 2 {
            return None;
        }
        let now = recents::now();
        let until = snooze::presets(now).first().map(|(_, until)| *until);
        Some(
            div()
                .id("sidebar-bulk-bar")
                .debug_selector(|| "sidebar-bulk-bar".into())
                .flex_none()
                .mx(px(6.))
                .mb(px(6.))
                .p(px(4.))
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(2.))
                .rounded(px(10.))
                .bg(crate::theme::popover_background())
                .border_1()
                .border_color(theme().border)
                .child(
                    div()
                        .px(px(7.))
                        .text_size(px(12.))
                        .text_color(theme().text_muted)
                        .child(format!("{count} selected")),
                )
                .child(Self::bulk_button("sidebar-bulk-settle", "Settle", cx, |this, cx| {
                    this.bulk_settle(cx)
                }))
                .children(until.map(|until| {
                    Self::bulk_button("sidebar-bulk-snooze", "Snooze 1h", cx, move |this, cx| {
                        this.bulk_snooze(until, cx)
                    })
                }))
                .child(Self::bulk_button("sidebar-bulk-retitle", "Retitle", cx, |this, cx| {
                    this.bulk_retitle(cx)
                }))
                .child(Self::bulk_button("sidebar-bulk-archive", "Archive", cx, |this, cx| {
                    this.bulk_archive(cx)
                }))
                .child(Self::bulk_button("sidebar-bulk-clear", "Clear", cx, |this, cx| {
                    this.picked.clear();
                    cx.notify();
                }))
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
