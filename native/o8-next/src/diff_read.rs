//! Review reads retain only the canonical missing-checkout refusal as an action.
use super::*;
use crate::client::{Client, LOAD_REQUEST_TIMEOUT, get_with_retry};

#[derive(Clone, Debug)]
pub(crate) struct MissingCheckout {
    pub lane_id: String,
    pub detail: String,
}
pub(crate) struct ReadFailure {
    pub message: String,
    pub missing: Option<MissingCheckout>,
}
impl From<String> for ReadFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            missing: None,
        }
    }
}
impl From<&str> for ReadFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

fn packet_diff(client: &Client, packet: &str) -> Result<Response, ReadFailure> {
    let id: String = url::form_urlencoded::byte_serialize(packet.as_bytes()).collect();
    let mut url = client
        .url(&format!("/api/lanes/{id}/diff"))
        .map_err(|_| "Invalid route")?;
    url.query_pairs_mut().append_pair("maxBytes", "524288");
    let response = get_with_retry(|| {
        client
            .request("GET", &url)
            .timeout(LOAD_REQUEST_TIMEOUT)
            .call()
    });
    match response {
        Ok(response) => Client::read(response).map_err(Into::into),
        Err(ureq::Error::Status(status, response)) => {
            let reply = Client::read::<Value>(response).unwrap_or(Value::Null);
            let error = &reply["error"];
            let missing =
                if status == 409 && reply["ok"] == false && error["code"] == "worktree_missing" {
                    error["laneId"]
                        .as_str()
                        .filter(|id| !id.trim().is_empty())
                        .zip(
                            error["message"]
                                .as_str()
                                .filter(|message| !message.trim().is_empty()),
                        )
                        .map(|(lane_id, detail)| MissingCheckout {
                            lane_id: lane_id.into(),
                            detail: detail.into(),
                        })
                } else {
                    None
                };
            Err(ReadFailure {
                message: missing
                    .as_ref()
                    .map(|value| value.detail.clone())
                    .unwrap_or_else(|| format!("{}: Server returned HTTP {status}", url.path())),
                missing,
            })
        }
        Err(_) => Err(format!("{}: Could not reach the selected server", url.path()).into()),
    }
}

impl Target {
    /// A worker's inspector keeps its ordinary working diff. If that read fails,
    /// only the lane route can establish that its recorded checkout is gone.
    pub(crate) fn read_in_lane(
        &self,
        client: &Client,
        lane: Option<&str>,
    ) -> Result<(Document, Value), ReadFailure> {
        self.read_for_review(client).map_err(|original| {
            if matches!(self, Self::Worktree { .. }) {
                if let Some(lane) = lane.filter(|id| !id.trim().is_empty()) {
                    if let Err(failure) = packet_diff(client, lane) {
                        if failure.missing.is_some() {
                            return failure;
                        }
                    }
                }
            }
            original
        })
    }

    pub fn read(&self, client: &Client) -> Result<(Document, Value), String> {
        self.read_for_review(client).map_err(|error| error.message)
    }
    pub(crate) fn read_for_review(
        &self,
        client: &Client,
    ) -> Result<(Document, Value), ReadFailure> {
        let response: Response = match self {
            Self::Commit { path, hash } => {
                if !(7..=40).contains(&hash.len()) || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err("Invalid commit revision".into());
                }
                let value: Value = client.get(
                    &format!("/api/panel/commits/{hash}"),
                    &[("workspace", path)],
                )?;
                if value["error"].is_string() {
                    return Err(value["error"]
                        .as_str()
                        .unwrap_or("Commit unavailable")
                        .into());
                }
                let commit = &value["commit"];
                let diff = commit["diff"]
                    .as_str()
                    .ok_or("Commit diff unavailable")?
                    .to_owned();
                let head = commit["hash"]
                    .as_str()
                    .ok_or("Commit identity unavailable")?;
                if !head.to_lowercase().starts_with(&hash.to_lowercase()) {
                    return Err("Commit response belongs to another revision".into());
                }
                Response {
                    truncated: diff.ends_with("... (truncated at 50KB)"),
                    diff,
                    head_sha: head.into(),
                    ..Default::default()
                }
            }
            Self::Packet(packet) => packet_diff(client, packet)?,
            Self::Worktree { path, base, file } => {
                let mut query = vec![("worktreePath", path.as_str())];
                if let Some(base) = base {
                    query.push(("baseBranch", base));
                }
                if let Some(file) = file {
                    query.push(("file", file));
                }
                client.get("/api/worktrees/diff", &query)?
            }
        };
        if response.error.is_some() {
            return Err("Diff unavailable. Refresh the selected target.".into());
        }
        if response.head_sha.len() != 40
            || !response.head_sha.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Diff has no verifiable HEAD. Review is disabled.".into());
        }
        let state = match self {
            Self::Packet(id) => client.review_state(id)?,
            _ => Value::Null,
        };
        let mut document = if matches!(self, Self::Worktree { .. }) {
            parse_worktree(&response.diff)
        } else {
            parse(&response.diff)
        };
        document.head = response.head_sha;
        document.truncated = response.truncated;
        document.revision = response.revision;
        document.source = response.diff;
        Ok((document, state))
    }
}
