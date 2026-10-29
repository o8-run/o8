//! Surface-owned shell registration; viewer behavior lives in its existing component.
use super::*;
use serde_json::Value;
use std::time::Duration;
#[path = "diff/view.rs"]
mod view;
pub(super) type View = view::DiffSurface;
#[path = "diff/guard.rs"]
pub(crate) mod guard;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((5, || Command::InlineDiff)),
    create: |s, _, workspace, window, cx| {
        let client = s.client.in_workspace(&workspace);
        Some(Content::InlineDiff(cx.new(|cx| {
            view::DiffSurface::inline(
                client,
                crate::diff::Target::Worktree {
                    path: workspace,
                    base: None,
                    file: None,
                },
                window,
                cx,
            )
        })))
    },
    ..Registration::new("Diff", "Open inline diff", |_, _, _, _| {
        Some((Tab::InlineDiff, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).shell_focus(window);
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).ready
    }
}
#[cfg(test)]
#[path = "diff/tests.rs"]
mod tests;

// Request adapters compile with this surface through its existing shell entry.
impl Client {
    pub(crate) fn inline_approval_evidence(&self, packet: &str, id: &str) -> Result<Value, String> {
        let mut url = self.url("/api/orchestrator/review-state").unwrap();
        url.query_pairs_mut().extend_pairs([
            ("packetId", packet),
            ("spoken", "1"),
            ("approvalId", id),
        ]);
        // Spoken proof rebuilds the Git and governance gates on the server.
        let response = self
            .request("GET", &url)
            .timeout(Duration::from_secs(180))
            .call()
            .map_err(|error| match error {
                ureq::Error::Status(code, _) => format!("Server returned HTTP {code}"),
                _ => "Approval evidence is not ready. Retry Review approval.".into(),
            })?;
        Self::read(response)
    }
    pub(crate) fn inline_confirm_receipt(
        &self,
        packet: &str,
        id: &str,
        evidence: &Value,
    ) -> Result<(u16, Value), String> {
        let url = self.url("/api/panel/approvals").unwrap();
        let request = self.with_desktop_identity(self.request("POST", &url));
        if let Ok(response) | Err(ureq::Error::Status(_, response)) = request.send_json(
            serde_json::json!({"id":id,"action":"approve","spokenReviewEvidence":evidence}),
        ) {
            let status = response.status();
            if let Ok(mut data) = Self::read::<Value>(response) {
                guard::scrub(&mut data);
                if !(200..300).contains(&status)
                    || data["ok"] != true
                    || data["approval"]["resolution"]["continuationStatus"] != "pending"
                {
                    return Ok((status, data));
                }
            }
        }
        // A timeout/lost response can outlive the request. Read the durable receipt;
        // never issue another mutation or invent a replacement approval.
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        loop {
            if let Ok(data) = self.get::<Value>(
                "/api/panel/approvals",
                &[("packetId", packet), ("status", "all")],
            ) && let Some(approval) = data["approvals"]
                .as_array()
                .and_then(|a| a.iter().find(|a| a["id"] == id))
            {
                let status = approval["resolution"]["continuationStatus"].as_str();
                if approval["status"] != "pending" && !matches!(status, Some("pending")) {
                    let mut receipt = serde_json::json!({"ok":true,"approval":approval});
                    guard::scrub(&mut receipt);
                    return Ok((200, receipt));
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("Confirmation unconfirmed. Inspect Inbox before retrying.".into());
            }
            std::thread::sleep(Duration::from_millis(750));
        }
    }
    pub(crate) fn inline_merge_receipt(&self, body: &Value) -> Result<(u16, Value), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        loop {
            let url = self.url("/api/orchestrator/merge").unwrap();
            let request = self.request("POST", &url);
            if let Ok(response) | Err(ureq::Error::Status(_, response)) =
                request.send_json(body.clone())
            {
                let status = response.status();
                if let Ok(mut data) = Self::read::<Value>(response) {
                    crate::shell::inline_diff::guard::scrub(&mut data);
                    let result = data.get("result").unwrap_or(&data);
                    let pending = result["outcomeUnknown"] != true
                        && (status == 202
                            || result["inProgress"] == true
                            || result["status"] == "in_progress");
                    if !(200..300).contains(&status) || data["ok"].is_boolean() && !pending {
                        return Ok((status, data));
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("Merge is still running or its receipt is unavailable. Retry reuses this decision.".into());
            }
            std::thread::sleep(Duration::from_millis(750));
        }
    }
}
