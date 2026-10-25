//! A held merge resolves its original approval after fresh read-only admission.
use super::*;

pub(super) fn evidence(client: &Client, held: &HeldApproval) -> Result<(Value, Value), String> {
    let receipt = client.inline_approval_evidence(&held.packet, &held.id)?;
    let facts = &receipt["spokenReview"]["evidence"];
    let fingerprint = |name: &str| {
        facts[name]
            .as_str()
            .is_some_and(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    if receipt["packetId"] != held.packet
        || facts["headSha"] != held.head
        || !fingerprint("fingerprint")
        || !fingerprint("governanceFingerprint")
    {
        return Err("Approval evidence unavailable. Inspect Inbox before confirming.".into());
    }
    Ok((
        json!({"approvalId":held.id,"packetId":held.packet,"reviewedHeadSha":held.head,
        "reviewedDiffFingerprint":facts["fingerprint"],"reviewedGovernanceFingerprint":facts["governanceFingerprint"]}),
        receipt["spokenReview"]["mergeGate"]["checks"].clone(),
    ))
}

fn preflight(
    client: &Client,
    workspace: &str,
    held: &HeldApproval,
    review: bool,
) -> Result<Value, String> {
    let state: Value = client.get("/api/orchestrator/state", &[])?;
    let packet = state["mission"]["packets"]
        .as_array()
        .and_then(|packets| packets.iter().find(|p| p["id"] == held.packet))
        .ok_or("Packet unavailable. Approval retained.")?;
    if packet["operatorStopped"] == true || packet["holdIntent"] == "operator" {
        return Err("Packet is stopped. Approval retained.".into());
    }
    let target = packet_target(client, workspace, &held.packet)?;
    if !matches!((&target, &held.target), (Target::Worktree { path: a, .. }, Target::Worktree { path: b, .. })
        if crate::client::same_workspace(a, b))
    {
        return Err("Packet worktree changed. Approval retained.".into());
    }
    let lane_id = packet["lane"]["laneId"]
        .as_str()
        .ok_or("Packet has no current lane")?;
    let segment: String = url::form_urlencoded::byte_serialize(lane_id.as_bytes()).collect();
    let lane: Value = client.get(&format!("/api/lanes/{segment}"), &[])?;
    if matches!(
        lane["lane"]["status"].as_str(),
        Some("running" | "launching" | "merging")
    ) {
        return Err("Lane runtime is active. Approval retained.".into());
    }
    let (current, _) = read(&held.target, client)?;
    if current.head != held.head
        || current.source != held.source
        || current.truncated
        || current.unsupported
    {
        return Err("Diff changed. Reopen and review before confirming.".into());
    }
    let approvals: Value = client.get(
        "/api/panel/approvals",
        &[("packetId", &held.packet), ("status", "all")],
    )?;
    let approval = approvals["approvals"]
        .as_array()
        .and_then(|items| items.iter().find(|a| a["id"] == held.id))
        .ok_or("Approval unavailable. Inspect Inbox before retrying.")?;
    let continuation = &approval["continuation"];
    if approval["status"] != "pending"
        || continuation["kind"] != "lane"
        || continuation["verb"] != "merge"
        || continuation["laneId"] != lane_id
        || continuation["expectedHeadSha"] != held.head
    {
        return Err("Approval changed. Inspect Inbox before retrying.".into());
    }
    let (current_evidence, checks) = evidence(client, held)?;
    if !review && held.evidence.as_ref() != Some(&current_evidence) {
        return Err("Approval governance changed. Reopen and review before confirming.".into());
    }
    let checks = checks
        .as_array()
        .filter(|checks| !checks.is_empty())
        .ok_or("Merge checks unavailable")?;
    // The frozen server receipt proves these are the held card's unchanged gates.
    let acknowledged = |name: &str| match name {
        "merge-approval" => true,
        "mission-merge-hold" => approval["policyRuleId"] == "mission-merge-hold",
        "merge-policy" => matches!(
            approval["policyRuleId"].as_str(),
            Some("lane-merge" | "surface-dispatcher-review")
        ),
        "file-size-approval" => approval["policyRuleId"] == "file_size_limit",
        _ => false,
    };
    if checks.iter().any(|check| {
        !matches!(check["verdict"].as_str(), Some("pass" | "fail" | "skipped"))
            || check["verdict"] == "fail" && !check["name"].as_str().is_some_and(acknowledged)
    }) {
        return Err("Merge gates changed. Resolve current blockers before Confirm.".into());
    }
    Ok(current_evidence)
}

impl DiffSurface {
    pub(super) fn inline_confirm(&mut self, cx: &mut Context<Self>) {
        self.inline_approval_action(false, cx);
    }
    pub(super) fn inline_review_approval(&mut self, cx: &mut Context<Self>) {
        self.inline_approval_action(true, cx);
    }
    fn inline_approval_action(&mut self, review: bool, cx: &mut Context<Self>) {
        if self.busy || !self.ready || self.document.truncated || self.document.unsupported {
            return;
        }
        let state = self.inline.as_ref().unwrap();
        let Some(approval) = state.approval.clone() else {
            return;
        };
        if review != approval.evidence.is_none() {
            return;
        }
        if state.packet.read(cx).text.trim() != approval.packet
            || self.target != approval.target
            || self.document.head != approval.head
            || self.document.source != approval.source
            || !state.has_selection(&self.document)
        {
            self.notice = "Displayed packet changed. Approval retained.".into();
            cx.notify();
            return;
        }
        let client = self.client.clone();
        let workspace = state.workspace.clone();
        self.busy = true;
        self.notice = "Checking merge approval…".into();
        let task = cx.background_executor().spawn(async move {
            let evidence = preflight(&client, &workspace, &approval, review)?;
            if review {
                return Ok(Some(evidence));
            }
            let (status, data) =
                client.inline_confirm_receipt(&approval.packet, &approval.id, &evidence)?;
            if !(200..300).contains(&status)
                || data["ok"] != true
                || data["approval"]["id"] != approval.id
            {
                if data["code"] == "spoken_review_changed" {
                    return Err("Approval governance changed. Review approval again.".to_owned());
                }
                return Err("Confirmation refused. Approval retained; inspect Inbox.".to_owned());
            }
            if data["approval"]["status"] != "approved"
                || data["approval"]["resolution"]["continuationStatus"] != "completed"
            {
                return Err(
                    "Approval continuation is unconfirmed. Inspect Inbox before retrying."
                        .to_owned(),
                );
            }
            Ok(None)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.busy = false;
                match result {
                    Ok(None) => {
                        s.inline.as_mut().unwrap().approval = None;
                        s.notice = "Merged".into();
                    }
                    Ok(Some(evidence)) => {
                        s.inline
                            .as_mut()
                            .unwrap()
                            .approval
                            .as_mut()
                            .unwrap()
                            .evidence = Some(evidence);
                        s.notice = "Approval ready. Confirm to merge.".into();
                    }
                    Err(error) => {
                        if error.starts_with("Approval governance changed.") {
                            s.inline
                                .as_mut()
                                .unwrap()
                                .approval
                                .as_mut()
                                .unwrap()
                                .evidence = None;
                        }
                        s.notice = error;
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
