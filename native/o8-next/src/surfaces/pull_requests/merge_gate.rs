use super::*;

pub(super) enum Submission {
    Refused(String),
    Sent(Result<Value, String>),
}

pub(super) fn snapshot(detail: &Value) -> Result<&str, String> {
    let gate = &detail["mergeGate"];
    let value = string(gate, "snapshot");
    if !gate["allowed"].is_boolean()
        || value.len() != 64
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
        || string(gate, "repo").to_lowercase() != string(detail, "resolvedRepo").to_lowercase()
        || gate["number"] != detail["number"]
        || string(gate, "headSha").is_empty()
        || string(gate, "baseSha").is_empty()
        || gate["headSha"] != detail["headSha"]
        || gate["baseSha"] != detail["baseSha"]
        || gate["baseRefName"] != detail["baseRefName"]
        || !gate["checks"].is_array()
        || array(gate, "checks").is_empty()
        || !array(gate, "checks")
            .iter()
            .all(|c| ["pass", "fail", "skipped"].contains(&string(c, "verdict")))
        || !gate["packets"].is_array()
    {
        return Err("Merge gates are unavailable or do not match this pull request. Refresh before merging.".into());
    }
    Ok(value)
}

pub(super) fn governance(detail: &Value) -> Result<(Option<String>, Value), String> {
    snapshot(detail)?;
    let packets = array(&detail["mergeGate"], "packets");
    Ok((
        packets.first().map(|p| string(p, "id").to_owned()),
        packets
            .first()
            .map(|p| p["preview"].clone())
            .unwrap_or(Value::Null),
    ))
}

pub(super) fn submit(client: &Client, sent: &Confirmation) -> Submission {
    if ["merge", "enable-auto-merge"].contains(&sent.action.as_str()) {
        let fresh = match client.get::<Value>(
            &format!("/api/panel/prs/{}", sent.number),
            &[("repo", &sent.repo)],
        ) {
            Ok(value) => value,
            Err(_) => {
                return Submission::Refused(
                    "Merge gates could not be refreshed. No merge was sent.".into(),
                );
            }
        };
        let detail = &fresh["pr"];
        if snapshot(detail).is_err()
            || snapshot(detail).ok() != sent.merge_gate.as_deref()
            || detail["mergeGate"]["allowed"] != true
            || string(detail, "headSha") != sent.head
        {
            return Submission::Refused("Merge gates or packet membership changed. Review the refreshed pull request before confirming again. No merge was sent.".into());
        }
    }
    let mut body = json!({"repo":sent.repo,"action":sent.action,"comment":sent.body,
        "commitSha":sent.head,"mergeMethod":sent.method});
    if let Some(snapshot) = &sent.merge_gate {
        body["expectedMergeGate"] = json!(snapshot);
    }
    Submission::Sent(client.pr_post(&format!("/api/panel/prs/{}", sent.number), &body))
}
