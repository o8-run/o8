//! Existing lane and close-unmerged controls, shared by the expanded card.
use super::super::packet::Command as Packet;
use super::*;
impl ActivityPane {
    pub(super) fn packet_controls(
        &mut self,
        row: &Row,
        details: gpui::AnyElement,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut view = div()
            .flex()
            .flex_wrap()
            .gap(px(6.))
            .debug_selector(|| "activity-packet-actions".into());
        if let Some(key) = row.data["lane"]["sessionKey"]
            .as_str()
            .or(row.data["lane"]["tabId"].as_str())
            .filter(|s| !s.is_empty())
        {
            view = view.child(self.packet_button(
                "activity-open-worker",
                "Open worker",
                Action::Worker(key.into()),
                cx,
            ));
        }
        // PacketCard's lifecycle buttons and review section.
        let status = text(&row.data, "status");
        let lane = !text(&row.data["lane"], "laneId").is_empty();

        if lane
            && row.data["operatorStopped"] != true
            && matches!(status.as_str(), "running" | "launching" | "recovering")
        {
            view = view.child(self.packet_button(
                "activity-lane-stop",
                "Stop",
                Action::Lane(row.clone(), "stop"),
                cx,
            ));
        }
        if lane && matches!(status.as_str(), "idle" | "awaiting_review" | "recovering") {
            view = view.child(self.packet_button(
                "activity-lane-resume",
                "Resume",
                Action::Lane(row.clone(), "resume"),
                cx,
            ));
        }
        if lane
            && (status == "awaiting_review"
                || (status == "blocked" && row.data["blockedReason"] == "Awaiting operator input"))
        {
            view = view.child(self.packet_button(
                "activity-lane-create-pr",
                "Create PR",
                Action::Lane(row.clone(), "create_pr"),
                cx,
            ));
            view = view.child(self.packet_button(
                "activity-lane-merge",
                "Merge",
                Action::Lane(row.clone(), "merge"),
                cx,
            ));
        }

        if row.data["queueState"] == "held" || row.data["lane"].is_null() {
            let held = row.data["queueState"] == "held";
            view = view.child(self.packet_button(
                if held {
                    "activity-release"
                } else {
                    "activity-hold"
                },
                if held { "Release hold" } else { "Hold" },
                Action::Hold(row.clone(), !held),
                cx,
            ));
        }

        view = view.child(details);
        let archived = row.data["archivedAt"].is_string();
        let mut destructive = div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .flex_wrap()
            .gap(px(6.))
            .debug_selector(|| "activity-packet-destructive".into());
        if status == "awaiting_review" && self.closing.as_deref() != Some(row.id.as_str()) {
            destructive = destructive.child(self.packet_button(
                "activity-close-unmerged",
                "Close unmerged…",
                Action::CloseAsk(Some(row.id.clone())),
                cx,
            ));
        }
        destructive = destructive.child(self.packet_button(
            "activity-packet-archive",
            if archived { "Restore" } else { "Archive" },
            Action::Packet(Packet::Patch(
                row.clone(),
                json!({"archivedAt":if archived { Value::Null } else { json!(packet::iso_now()) }}),
            )),
            cx,
        ));
        view = view.child(destructive);
        if self.closing.as_deref() == Some(row.id.as_str()) {
            view = view.child(self.close_unmerged(row, cx));
        }

        view
    }
}
