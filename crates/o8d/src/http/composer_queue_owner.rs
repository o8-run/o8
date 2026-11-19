//! One process owns the durable queue. This module performs no provider calls.
//! Paths are configuration, not an admission/grant cache; SQLite is reopened.
use super::{composer_queue_store as store, composer_queue_target as target, *};
use std::time::Duration;
#[derive(Clone, Debug)]
pub(crate) struct QueueError {
    pub code: &'static str,
    pub message: String,
}
impl QueueError {
    pub(super) fn invalid(message: &str) -> Self {
        Self {
            code: "invalid",
            message: message.into(),
        }
    }
    pub(super) fn unavailable() -> Self {
        Self {
            code: "unavailable",
            message: "Unable to update the queued message.".into(),
        }
    }
    pub(crate) fn wire(&self) -> Value {
        json!({"code":self.code,"message":self.message})
    }
}
impl From<store::Error> for QueueError {
    fn from(error: store::Error) -> Self {
        let (code, message) = match error {
            store::Error::IdentityConflict => (
                "conflict",
                "This queue identity already belongs to another message.",
            ),
            store::Error::QueueFull => (
                "limit",
                "This chat already has 20 queued messages. Remove one before adding another.",
            ),
            store::Error::FollowupExists => (
                "limit",
                "A voice follow-up is already queued. Remove it before replacing it.",
            ),
            store::Error::NotFound => (
                "not_found",
                "This queued message was not found in this chat.",
            ),
            store::Error::NotSteerable => (
                "not_claimable",
                "This message cannot be steered after delivery has started.",
            ),
            store::Error::InvalidPayload => (
                "invalid",
                "The queued message needs a complete routing snapshot.",
            ),
            store::Error::Database(_) => return Self::unavailable(),
        };
        Self {
            code,
            message: message.into(),
        }
    }
}
#[derive(Clone)]
pub(crate) struct ResponseLimit;
pub(crate) struct Answer {
    pub result: Value,
    pub notice: Option<commit_notice::CommitNotice>,
}
struct AdmissionTarget {
    repo: String,
    thread: String,
    ingress: Option<(composer_queue_ingress::Ingress, Option<String>, String)>,
}
pub(crate) struct Owner {
    pub(super) directory: PathBuf,
    pub(super) database: PathBuf,
    media_root: PathBuf,
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, QueueError> {
    v[key]
        .as_str()
        .ok_or_else(|| QueueError::invalid("Invalid composer queue request."))
}
impl Owner {
    pub(crate) fn configured() -> Result<Self, QueueError> {
        let directory = std::env::var_os("O8D_SESSION_DATA_DIR")
            .map(PathBuf::from)
            .ok_or_else(QueueError::unavailable)?;
        let media = media_root(
            &directory,
            std::env::var_os("CORTEX_IDE_MEDIA_ROOT").as_deref(),
        )?;
        let database = std::env::var_os("O8D_SESSION_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.join("cortex-ide.db"));
        Self::with_database(directory, database, media)
    }
    #[cfg(test)]
    pub(crate) fn new(directory: PathBuf, media_root: PathBuf) -> Result<Self, QueueError> {
        let database = directory.join("cortex-ide.db");
        Self::with_database(directory, database, media_root)
    }
    fn with_database(
        directory: PathBuf,
        database: PathBuf,
        media_root: PathBuf,
    ) -> Result<Self, QueueError> {
        let directory = directory
            .canonicalize()
            .map_err(|_| QueueError::unavailable())?;
        let owner = Self {
            database,
            directory,
            media_root,
        };
        let mut db = owner.open()?;
        composer_queue_schema::initialize(
            &mut db,
            chrono::Utc::now().timestamp_millis(),
            |raw, steer| owner.compact(raw, steer),
        )?;
        Ok(owner)
    }
    fn open(&self) -> Result<Connection, QueueError> {
        if std::fs::symlink_metadata(&self.database)
            .is_ok_and(|m| m.file_type().is_symlink() || !m.is_file())
        {
            return Err(QueueError::unavailable());
        }
        let db = Connection::open_with_flags(
            &self.database,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| QueueError::unavailable())?;
        db.busy_timeout(Duration::from_millis(5000))
            .map_err(|_| QueueError::unavailable())?;
        Ok(db)
    }
    fn compact(&self, raw: &str, steer: bool) -> Result<String, store::Error> {
        composer_queue_media::compact(raw, steer, &self.media_root)
    }
    pub(crate) fn attach(&self, boot: &str) -> Result<usize, QueueError> {
        Ok(store::attach_boot(
            &mut self.open()?,
            boot,
            chrono::Utc::now().timestamp_millis(),
        )?)
    }
    /// Internal non-executor callers never get an attempt token or a claim.
    pub(crate) fn internal_method(method: &str) -> bool {
        matches!(
            method,
            "enqueue" | "get" | "list" | "listTargets" | "listTranscript" | "promote" | "cancel"
        )
    }
    pub(crate) fn execute(&self, method: &str, params: &Value) -> Result<Answer, QueueError> {
        if !params.is_object() {
            return Err(QueueError::invalid("Invalid composer queue request."));
        }
        let mut db = self.open()?;
        let now = chrono::Utc::now().timestamp_millis();
        let mut notice = None;
        let mut record_notice = |item: &Value| {
            notice = commit_notice::CommitNotice::composer(
                item["id"].as_str().unwrap_or(""),
                item["threadId"].as_str().unwrap_or(""),
                item["repoPath"].as_str().unwrap_or(""),
                now,
            );
        };
        let result = match method {
            "enqueue" => {
                let id = string(params, "id")?;
                if !(8..=120).contains(&id.len())
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    || !matches!(params["intent"].as_str(), Some("send-next" | "steer-now"))
                {
                    return Err(QueueError::invalid("A valid queue identity is required."));
                }
                let raw = string(params, "payloadJson")?;
                let payload: Value = serde_json::from_str(raw).map_err(|_| {
                    QueueError::invalid("The queued message needs a complete routing snapshot.")
                })?;
                let normalized =
                    composer_queue_validate::normalize(&payload, params.get("ingress").is_some())
                        .map_err(|m| QueueError::invalid(&m))?;
                if raw != normalized {
                    return Err(QueueError::invalid(
                        "The queued message needs a complete routing snapshot.",
                    ));
                }
                let target = self.admission_target(&db, params, &payload)?;
                let sidecar = target.ingress.as_ref().map(|(s, _, _)| store::Ingress {
                    json: &s.json,
                    hash: &s.hash,
                });
                let input = store::Admission {
                    id,
                    repo_path: &target.repo,
                    thread_id: &target.thread,
                    intent: string(params, "intent")?,
                    payload_json: raw,
                    ingress: sidecar.as_ref(),
                };
                let change = if let Some((_, real, synthetic)) = &target.ingress {
                    store::enqueue_resolved(
                        &mut db,
                        input,
                        now,
                        Some((real.as_deref(), synthetic)),
                        || {
                            if let Some(thread) = real {
                                let record = target::history(self, thread)
                                    .map_err(|_| store::Error::InvalidPayload)?;
                                if record["exists"] != false {
                                    return Ok(thread.clone());
                                }
                            }
                            Ok(synthetic.clone())
                        },
                    )?
                } else {
                    store::enqueue(&mut db, input, now)?
                };
                if change.changed {
                    record_notice(&change.item);
                }
                json!({"item":change.item,"disposition":if change.changed {"created"}else{"existing"}})
            }
            "get" => {
                let id = string(params, "id")?;
                let mut result = json!({"item":store::read(&db,id)?});
                if let Some(token) = params.get("claimToken") {
                    let token = token
                        .as_str()
                        .ok_or_else(|| QueueError::invalid("Invalid composer queue request."))?;
                    result["attempt"] = json!({"tokenMatches":store::assert_claim(&db,id,token)?,"admitted":!result["item"]["admittedAt"].is_null()});
                }
                result
            }
            "listTargets" => json!({"targets":store::targets(&db)?}),
            "list" => {
                let items = if let Some(t) = params.get("target") {
                    let (r, t) = self.key(t)?;
                    store::list(
                        &db,
                        &store::Target {
                            repo_path: &r,
                            thread_id: &t,
                        },
                    )?
                } else {
                    store::list_all(&db)?
                };
                json!({"items":items})
            }
            "listTranscript" => {
                let (r, t) = self.key(&params["target"])?;
                json!({"items":self.transcript(&db,&r,&t)?})
            }
            "claim" => {
                let claim = match string(params, "intent")? {
                    "send-next" => {
                        let (r, t) = self.key(&params["target"])?;
                        store::claim(
                            &mut db,
                            &store::Target {
                                repo_path: &r,
                                thread_id: &t,
                            },
                            now,
                        )?
                    }
                    "steer-now" => store::claim_steer(&mut db, string(params, "id")?, now)?,
                    "ingress" => store::claim_ingress(&mut db, string(params, "id")?, now)?,
                    _ => return Err(QueueError::invalid("Invalid composer queue claim.")),
                };
                match claim {
                    None => json!({"item":null}),
                    Some(claim) => {
                        record_notice(&claim.item);
                        let mut answer = json!({"item":claim.item,"claimToken":claim.token});
                        if let Some(ingress) = claim.ingress {
                            answer["ingress"] = ingress;
                        }
                        answer
                    }
                }
            }
            "assertClaim" => {
                json!({"live":store::assert_claim(&db,string(params,"id")?,string(params,"claimToken")?)?})
            }
            "admit" | "settle" | "deferSteer" => {
                let id = string(params, "id")?;
                let token = string(params, "claimToken")?;
                let metadata = store::notice_target(&db, id)?;
                let changed = match method {
                    "admit" => store::admit(&db, id, token, now)?,
                    "deferSteer" => {
                        store::defer_steer(&db, id, token, string(params, "reason")?, now)?
                    }
                    _ => {
                        let reason = params
                            .get("reason")
                            .map(|v| {
                                v.as_str().ok_or_else(|| {
                                    QueueError::invalid("Invalid composer queue reason.")
                                })
                            })
                            .transpose()?;
                        store::settle(
                            &mut db,
                            id,
                            token,
                            string(params, "status")?,
                            reason,
                            now,
                            |s, b| self.compact(s, b),
                        )?
                    }
                };
                if changed {
                    if let Some(item) = metadata {
                        record_notice(&item);
                    }
                }
                json!({"changed":changed})
            }
            "promote" | "cancel" | "hold" => {
                let (repo, thread) = self.key(&params["target"])?;
                let target = store::Target {
                    repo_path: &repo,
                    thread_id: &thread,
                };
                if method == "promote" {
                    let changed = store::promote(&mut db, &target, string(params, "id")?, now)?;
                    if changed.changed {
                        record_notice(&changed.item);
                    }
                    json!({"item":changed.item})
                } else {
                    let changed = if method == "cancel" {
                        store::cancel(&mut db, &target, string(params, "id")?, now, |s, b| {
                            self.compact(s, b)
                        })?
                    } else {
                        store::hold(&mut db, &target, now, |s, b| self.compact(s, b))?
                    };
                    if changed {
                        notice = commit_notice::CommitNotice::composer(
                            if method == "cancel" {
                                string(params, "id")?
                            } else {
                                &thread
                            },
                            &thread,
                            &repo,
                            now,
                        );
                    }
                    json!({"changed":changed})
                }
            }
            _ => return Err(QueueError::invalid("Invalid composer queue method.")),
        };
        Ok(Answer { result, notice })
    }
    fn key(&self, value: &Value) -> Result<(String, String), QueueError> {
        let repo = string(value, "repoPath")?;
        let thread = string(value, "threadId")?;
        if repo.encode_utf16().count() > 4096
            || !repo.starts_with('/')
            || thread.is_empty()
            || thread.len() > 256
        {
            return Err(QueueError::invalid(
                "A valid repository and chat are required.",
            ));
        }
        Ok((target::repo_key(repo), thread.into()))
    }
    fn admission_target(
        &self,
        db: &Connection,
        params: &Value,
        payload: &Value,
    ) -> Result<AdmissionTarget, QueueError> {
        if let Some(ingress) = params.get("ingress") {
            if ingress["kind"] != "ws" {
                return Err(QueueError::invalid("Invalid composer queue ingress."));
            }
            let wire = string(ingress, "wireJson")?;
            let parsed: Value = serde_json::from_str(wire)
                .map_err(|_| QueueError::invalid("Invalid composer queue ingress."))?;
            let mutation = string(ingress, "clientMutationId")?;
            if mutation.is_empty()
                || mutation.len() > 1024
                || parsed["clientMutationId"] != mutation
            {
                return Err(QueueError::invalid("Invalid composer queue ingress."));
            }
            let repo = string(&params["target"], "repoPath")?;
            if !repo.starts_with('/')
                || repo.encode_utf16().count() > 4096
                || target::repo_key(repo) != repo
            {
                return Err(QueueError::invalid(
                    "A valid repository and chat are required.",
                ));
            }
            let raw_thread = match parsed.get("threadId") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.as_str()),
                _ => return Err(QueueError::invalid("Invalid composer queue ingress.")),
            };
            let (id, synthetic) = composer_queue_ingress::identity(repo, raw_thread, mutation)
                .map_err(|_| QueueError::invalid("Invalid composer queue ingress."))?;
            if params["id"] != id {
                return Err(QueueError::invalid(
                    "Invalid composer queue ingress identity.",
                ));
            }
            let resolved = composer_queue_ingress::resolved_thread(raw_thread);
            let thread = string(&params["target"], "threadId")?;
            if thread != synthetic && resolved != Some(thread) {
                return Err(QueueError::invalid(
                    "Invalid composer queue ingress target.",
                ));
            }
            let saved = composer_queue_ingress::compact(wire, &payload["images"])
                .map_err(|_| QueueError::invalid("Invalid composer queue ingress."))?;
            Ok(AdmissionTarget {
                repo: repo.into(),
                thread: thread.into(),
                ingress: Some((saved, resolved.map(str::to_owned), synthetic)),
            })
        } else {
            let (repo, thread) = target::validate(self, db, &params["target"], true)?;
            Ok(AdmissionTarget {
                repo,
                thread,
                ingress: None,
            })
        }
    }
    fn transcript(
        &self,
        db: &Connection,
        repo: &str,
        thread: &str,
    ) -> Result<Vec<Value>, QueueError> {
        if thread.starts_with("wsi:") {
            return Ok(vec![]);
        }
        let mut items = store::transcript(db, repo, thread)?;
        let record = target::history(self, thread)?;
        let messages = record["messages"]
            .as_array()
            .ok_or_else(QueueError::unavailable)?;
        for item in &mut items {
            let id = format!("composer-steer-{}", string(item, "id")?);
            let message = messages.iter().find(|m| m["id"] == id);
            if item["status"] == "applied" {
                item["payload"]["text"] = message
                    .and_then(|m| m.get("content"))
                    .cloned()
                    .unwrap_or(json!(""));
                item["payload"]["images"] =
                    json!(super::queue::images(&item["payload"])
                        .map_err(|_| QueueError::unavailable())?);
            }
            if let Some(anchor) = message.and_then(|m| m.get("steerAnchor")) {
                item["steerAnchor"] = anchor.clone();
            }
        }
        Ok(items)
    }
}

#[cfg(test)]
#[path = "composer_queue_owner_tests.rs"]
mod tests;

fn media_root(
    directory: &Path,
    override_path: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, QueueError> {
    // Node path.join normalizes a relative override but retains a relative
    // recorded media path. Both owners have the same server_dir cwd.
    let path = override_path
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.join("media"));
    let value = path.to_str().ok_or_else(QueueError::unavailable)?;
    let mut parts = Vec::<&str>::new();
    for part in value.split('/') {
        match part {
            "" | "." => (),
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if !value.starts_with('/') => parts.push(part),
            ".." => (),
            _ => parts.push(part),
        }
    }
    let normalized = format!(
        "{}{}",
        if value.starts_with('/') { "/" } else { "" },
        parts.join("/")
    );
    Ok(PathBuf::from(if normalized.is_empty() {
        ""
    } else {
        &normalized
    }))
}

pub(crate) fn public_request(
    owner: &Owner,
    method: &str,
    query: &str,
    body: Option<Value>,
) -> Response {
    use axum::response::IntoResponse;
    let finish = |status: StatusCode, value: Value| {
        let mut response = (status, Json(value)).into_response();
        response.extensions_mut().insert(ResponseLimit);
        response
    };
    let result = (|| -> Result<Answer, QueueError> {
        let db = owner.open()?;
        if method == "GET" {
            let mut params = super::Params::new();
            for (k, v) in form_urlencoded::parse(query.as_bytes()).into_owned() {
                params.entry(k).or_insert(v);
            }
            let target =
                json!({"repoPath":params.get("repoPath"),"threadId":params.get("threadId")});
            let (repo, thread) = target::validate(owner, &db, &target, false)?;
            let items = owner.transcript(&db, &repo, &thread)?;
            return Ok(Answer {
                result: json!({"items":items,"canSteer":false,"steerableIds":[]}),
                notice: None,
            });
        }
        let body = body.ok_or_else(|| QueueError::invalid("A queue request is required."))?;
        if method == "POST" && !body.is_object() {
            return Err(QueueError::invalid("A queue request is required."));
        }
        if method == "POST" {
            let id = body["id"].as_str().unwrap_or("");
            if !(8..=120).contains(&id.len())
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                || !matches!(body["intent"].as_str(), Some("send-next" | "steer-now"))
            {
                return Err(QueueError::invalid("A valid queue identity is required."));
            }
        }
        let (repo, thread) = target::validate(owner, &db, &body, method != "DELETE")?;
        let target = json!({"repoPath":repo,"threadId":thread});
        match method {
            "POST" => {
                // Identity validation precedes target/payload in the existing store.
                let raw = composer_queue_validate::normalize(&body["payload"], false)
                    .map_err(|m| QueueError::invalid(&m))?;
                let mut answer=owner.execute("enqueue",&json!({"id":body["id"],"intent":body["intent"],"target":target,"payloadJson":raw}))?;
                answer.result = json!({"item":answer.result["item"]});
                Ok(answer)
            }
            "PATCH" => {
                if !body["id"].is_string() {
                    return Err(QueueError::invalid(
                        "A queued message identity is required.",
                    ));
                }
                owner.execute("promote", &json!({"target":target,"id":body["id"]}))
            }
            "DELETE" => {
                if !body["id"].is_string() {
                    return Err(QueueError{code:"not_claimable",message:"This message is already executing or is no longer queued. Inspect the chat before stopping it.".into()});
                }
                let mut answer =
                    owner.execute("cancel", &json!({"target":target,"id":body["id"]}))?;
                if answer.result["changed"] != true {
                    return Err(QueueError{code:"not_claimable",message:"This message is already executing or is no longer queued. Inspect the chat before stopping it.".into()});
                }
                answer.result = json!({"ok":true});
                Ok(answer)
            }
            _ => Err(QueueError::invalid("Invalid composer queue method.")),
        }
    })();
    match result {
        Ok(Answer { result, notice }) => {
            let mut response = finish(StatusCode::OK, result);
            if method == "GET" {
                response
                    .headers_mut()
                    .insert("cache-control", "no-store".parse().unwrap());
            }
            if let Some(notice) = notice {
                response.extensions_mut().insert(notice);
            }
            response
        }
        Err(error) => {
            let status = if error.code == "unavailable"
                || error.message
                    == "Network threads send through the agent bus, not the orchestrator queue."
            {
                StatusCode::SERVICE_UNAVAILABLE
            } else if method == "DELETE" && error.code == "not_claimable" {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            finish(status, json!({"error":error.message}))
        }
    }
}
