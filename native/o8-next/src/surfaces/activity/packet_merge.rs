//! Packet-bound Merge uses the same operation and persisted receipt as classic.
use super::feed::ReadError;
use super::*;

pub(super) const PATH: &str = "/api/orchestrator/merge";
pub(super) fn packet_id(row: &Row) -> Option<&str> {
    if row.kind == "packet" {
        Some(&row.id)
    } else {
        row.data["packetId"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
    }
}
impl ActivityPane {
    pub(super) fn merge_packet(&mut self, row: &Row, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let Some(packet) = packet_id(row).filter(|id| !id.trim().is_empty()) else {
            self.notice_error = true;
            self.notice = "This packet has no identity. Refresh before merging.".into();
            self.changed(cx);
            return;
        };
        if let Some((method, path, body)) = &self.unsettled {
            if *path == PATH && body["packetId"] == packet {
                let replay = (*method, *path, body.clone());
                self.mutate(replay.0, replay.1, replay.2, cx);
            } else {
                self.notice_error = true;
                self.notice = "An earlier decision is unsettled. Refresh to check it.".into();
                self.changed(cx);
            }
            return;
        }
        let head = row.data["review"]["reviewedHeadSha"]
            .as_str()
            .unwrap_or("")
            .trim();
        if !head.is_empty()
            && (!(7..=40).contains(&head.len()) || !head.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            self.notice_error = true;
            self.notice = "Saved review HEAD is invalid. Refresh the packet before merging.".into();
            self.changed(cx);
            return;
        }
        let mut random = [0; 16];
        if getrandom::fill(&mut random).is_err() {
            self.notice_error = true;
            self.notice = "Could not create a merge request identity. Retry.".into();
            self.changed(cx);
            return;
        }
        let key = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut body =
            json!({"packetId":packet,"idempotencyKey":format!("next-packet-merge-{key}")});
        if !head.is_empty() {
            body["expectedHeadSha"] = json!(head);
        }
        self.mutate("POST", PATH, body, cx);
    }
}
fn error(message: impl Into<String>, status: u16) -> ReadError {
    ReadError {
        message: message.into(),
        status: Some(status),
        retry: 0,
    }
}
/// Never automatically retry a new operation: callers replay this exact body.
pub(super) fn request(client: &Client, body: &Value) -> Result<Value, ReadError> {
    let url = client.url(PATH).map_err(|_| ReadError::invalid())?;
    let response = match client.request("POST", &url).send_json(body.clone()) {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(_) => {
            return Err(ReadError {
                message: "Could not reach the selected server".into(),
                status: None,
                retry: 0,
            });
        }
    };
    let status = response.status();
    let mut value: Value = Client::read(response).map_err(|_| ReadError::invalid())?;
    if value["error"]["code"] == "outcome_unknown" {
        // This key is quarantined server-side; replay cannot reconcile it.
        return Err(error(
            value["error"]["message"].as_str()
                .unwrap_or("The packet merge outcome is unknown. Inspect its state before retrying."),
            status,
        ));
    }
    if status >= 400 {
        return Err(error(
            value["error"]["message"]
                .as_str()
                .or(value["error"].as_str())
                .or(value["note"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Merge refused (HTTP {status}).")),
            status,
        ));
    }
    if status == 202
        || value["inProgress"] == true
        || value["result"]["inProgress"] == true
        || value["result"]["status"] == "in_progress"
    {
        if let Some(object) = value.as_object_mut() {
            object.insert("inProgress".into(), json!(true));
        }
        return Ok(value);
    }
    if value["ok"] == true && value["result"]["merged"] == true {
        return Ok(value);
    }
    if value["ok"] == true && value["result"]["merged"] == false {
        return Err(error(
            value["result"]["note"]
                .as_str()
                .unwrap_or("Merge was refused."),
            status,
        ));
    }
    // A malformed success is not proof that the operation did not happen.
    Err(ReadError::invalid())
}
