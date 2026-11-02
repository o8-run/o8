//! Parked workspace detail and explicit Restore; inbox Unsettle remains metadata only.
use super::super::thread_mutations_client::WorkspaceRestoreOutcome;
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, MouseButton, div, px};

fn freed_label(bytes: Option<i64>) -> String {
    let Some(bytes) = bytes else {
        return "Freed space unknown".into();
    };
    let sign = if bytes < 0 { "-" } else { "" };
    let amount = bytes.unsigned_abs();
    for (unit, scale) in [("GiB", 1_u64 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)] {
        if amount >= scale {
            return format!("{sign}{:.1} {unit} freed", amount as f64 / scale as f64);
        }
    }
    format!("{bytes} B freed")
}

impl ThreadList {
    pub(super) fn workspace_parked_detail(&self, id: &str) -> Option<AnyElement> {
        let parked = &self
            .sessions
            .iter()
            .find(|session| session.id == id)?
            .parked_workspaces;
        if parked.is_empty() {
            return None;
        }
        let bytes = parked.iter().try_fold(0_i64, |sum, entry| {
            sum.checked_add(entry.reclaimed_available_bytes?)
        });
        let sid = id.to_owned();
        let detail_id = id.to_owned();
        let key = bytes.map_or_else(|| "unknown".to_owned(), |value| value.to_string());
        let label = if parked.len() == 1 {
            "Parked".into()
        } else {
            format!("{} parked", parked.len())
        };
        Some(
            div()
                .debug_selector(move || format!("thread-workspace-parked-{sid}"))
                .flex()
                .items_center()
                .gap(px(4.))
                .flex_shrink_0()
                .text_size(px(11.))
                .text_color(theme().text_faint)
                .child(label)
                .child(
                    div()
                        .debug_selector(move || format!("thread-workspace-freed-{key}-{detail_id}"))
                        .child(format!("· {}", freed_label(bytes))),
                )
                .into_any_element(),
        )
    }

    pub(super) fn workspace_restore_items(
        &self,
        id: &str,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let Some(session) = self.sessions.iter().find(|session| session.id == id) else {
            return vec![];
        };
        session
            .parked_workspaces
            .iter()
            .enumerate()
            .map(|(index, parked)| {
                let id = id.to_owned();
                let packet = parked.packet_id.clone();
                let selector = format!("sidebar-row-workspace-restore-{packet}");
                let label = if session.parked_workspaces.len() == 1 {
                    "Restore workspace".into()
                } else {
                    format!("Restore workspace {}", index + 1)
                };
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
                    .hover(|style| style.bg(theme().hover))
                    .child(label)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.row_menu = None;
                        this.restore_workspace(id.clone(), packet.clone(), cx);
                    }))
                    .into_any_element()
            })
            .collect()
    }

    fn restore_workspace(&mut self, id: String, packet: String, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let Some(session) = self.sessions.iter().find(|session| {
            session.id == id
                && session
                    .parked_workspaces
                    .iter()
                    .any(|entry| entry.packet_id == packet)
        }) else {
            return;
        };
        let workspace = session.repo_path.clone();
        let mutation = self
            .pending_workspace_restores
            .entry(packet.clone())
            .or_insert_with(|| {
                format!(
                    "next-workspace-restore-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                )
            })
            .clone();
        self.saving = true;
        self.notice.clear();
        self.generation += 1;
        let client = self.client.clone();
        let target = packet.clone();
        let task = cx.background_executor().spawn(async move {
            client.restore_sidebar_workspace(workspace.as_deref(), &target, &mutation)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    WorkspaceRestoreOutcome::Restored => {
                        this.pending_workspace_restores.remove(&packet);
                        this.notice = "Workspace restored.".into();
                    }
                    WorkspaceRestoreOutcome::Refused(note) => {
                        this.pending_workspace_restores.remove(&packet);
                        this.notice = note;
                    }
                    WorkspaceRestoreOutcome::Unconfirmed(note) => this.notice = note,
                }
                this.generation += 1;
                this.load(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::freed_label;
    #[test]
    fn signed_or_unknown_parking_receipts_do_not_drop_the_session_listing() {
        for bytes in [Some(-1024_i64), Some(0), None] {
            let session: crate::client::Session = serde_json::from_value(serde_json::json!({
                "id": "parked", "title": "Parked", "status": "released", "parkedWorkspaces": [{
                    "packetId": "packet", "repositoryUuid": "repo", "reclaimedAvailableBytes": bytes,
                }],
            })).unwrap();
            assert_eq!(
                session.parked_workspaces[0].reclaimed_available_bytes,
                bytes
            );
        }
    }
    #[test]
    fn actual_freed_space_keeps_zero_unknown_and_signed_receipts_distinct() {
        assert_eq!(freed_label(Some(0)), "0 B freed");
        assert_eq!(freed_label(None), "Freed space unknown");
        assert_eq!(freed_label(Some(-1024)), "-1.0 KiB freed");
        assert_eq!(freed_label(Some(2_147_483_648)), "2.0 GiB freed");
    }
}
