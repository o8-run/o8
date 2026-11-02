//! Existing review/mutation routes and correlated per-note delegation receipts.
use super::super::editor::rail::Action as NoteAction;
use super::*;
impl Spec {
    pub(super) fn prewarm(&mut self, cx: &mut Context<Self>) {
        if !self.active
            || self.workspace.is_empty()
            || !self.prewarmed.insert(self.workspace.clone())
        {
            return;
        }
        let client = self.client.clone();
        let repo = self.workspace.clone();
        cx.background_executor()
            .spawn(async move {
                let _ = io::json_request(
                    &client,
                    "POST",
                    "/api/repo-spec",
                    &[("action", "prewarm-review"), ("repoPath", &repo)],
                    Some(json!({})),
                );
            })
            .detach();
    }
    pub(super) fn review(&mut self, cx: &mut Context<Self>) {
        self.note_action(
            NoteAction {
                id: String::new(),
                kind: "review".into(),
                message: String::new(),
            },
            cx,
        );
    }
    pub(super) fn note_action(&mut self, action: NoteAction, cx: &mut Context<Self>) {
        if self.workspace.is_empty()
            || !self.loaded_once
            || self.conflict.is_some()
            || self.reviewing
            || self.editor.read(cx).rail.busy.is_some()
        {
            return;
        }
        self.edits += 1;
        self.persist(false, cx);
        let generation = self.generation;
        let is_review = action.kind == "review";
        self.reviewing = is_review;
        if !is_review {
            self.editor.update(cx, |e, cx| {
                e.rail.busy = Some((action.id.clone(), action.kind.clone()));
                e.rail.feedback.remove(&action.id);
                cx.notify();
            });
        }
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            // Save first, then take the latest acknowledged draft. This prevents
            // a pending PUT from overwriting a note action's server mutation.
            let payload = loop {
                let state = this.update(cx, |s, _cx| {
                    if generation != s.generation {
                        return Err("Notes target changed".to_owned());
                    }
                    if s.conflict.is_some() {
                        return Err("Resolve the changed-on-disk conflict first.".into());
                    }
                    if let Some(error) = &s.error {
                        return Err(error.clone());
                    }
                    if s.pending || s.saving {
                        return Ok(None);
                    }
                    s.mutating = true;
                    Ok(Some((
                        s.client.clone(),
                        s.workspace.clone(),
                        s.content.clone(),
                    )))
                });
                match state {
                    Ok(Ok(Some(p))) => break Ok(p),
                    Ok(Ok(None)) => {
                        cx.background_executor()
                            .timer(Duration::from_millis(50))
                            .await
                    }
                    Ok(Err(e)) => break Err(e),
                    Err(_) => return,
                }
            };
            let result = match payload {
                Ok((client, repo, snapshot)) => {
                    let action = action.clone();
                    let sent = snapshot.clone();
                    let result = cx
                        .background_executor()
                        .spawn(async move { perform(&client, &repo, &sent, &action) })
                        .await;
                    result.map(|(body, feedback)| (body, feedback, snapshot))
                }
                Err(e) => Err(e),
            };
            let _ = this.update(cx, |s, cx| {
                if generation != s.generation {
                    return;
                }
                s.reviewing = false;
                s.mutating = false;
                let mut feedback = match result {
                    Ok((body, message, snapshot)) => {
                        let content = body["content"].as_str().unwrap_or(&snapshot).to_owned();
                        let hash = body["contentHash"].as_str().map(str::to_owned);
                        if s.content == snapshot {
                            s.edits += 1;
                            s.pending = false;
                            s.adopt(content, hash, true, cx);
                            s.saved = Some(Instant::now());
                        } else {
                            // Keep edits made during the request, with an explicit
                            // recovery choice instead of silently replacing them.
                            s.edits += 1;
                            s.pending = false;
                            s.conflict = Some(Conflict { content, hash });
                        }
                        (true, message)
                    }
                    Err(error) => {
                        if s.content != s.server && s.conflict.is_none() {
                            s.schedule_save(cx);
                        }
                        if is_review {
                            s.error = Some(error.clone());
                        }
                        (false, error)
                    }
                };
                if !is_review {
                    s.editor.update(cx, |e, cx| {
                        e.rail.busy = None;
                        if feedback.0 && action.kind == "reply" {
                            e.rail.reply = None;
                        }
                        e.rail
                            .feedback
                            .insert(action.id.clone(), std::mem::take(&mut feedback));
                        cx.notify();
                    });
                }
                cx.notify();
            });
        })
        .detach();
    }
}
fn post(client: &Client, repo: &str, action: &str, body: Value) -> Result<Value, String> {
    let (status, body) = io::json_request(
        client,
        "POST",
        "/api/repo-spec",
        &[("action", action), ("repoPath", repo)],
        Some(body),
    )?;
    if status >= 300 || body["ok"] != true {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Note action failed.")
            .into());
    }
    Ok(body)
}
fn perform(
    client: &Client,
    repo: &str,
    content: &str,
    action: &NoteAction,
) -> Result<(Value, String), String> {
    let (route, payload, message) = match action.kind.as_str() {
        "review" => {
            post(client, repo, "review", json!({"content":content}))?;
            let (status, body) =
                io::json_request(client, "GET", "/api/repo-spec", &[("repoPath", repo)], None)?;
            if status >= 300 || body["ok"] != true {
                return Err("Unable to load reviewed notes.".into());
            }
            return Ok((body, "Notes reviewed.".into()));
        }
        "apply" | "dismiss" => (
            "apply-suggestion",
            json!({"targetId":action.id,"accept":action.kind=="apply","content":content}),
            if action.kind == "apply" {
                "Applied to o8.md."
            } else {
                "Suggestion dismissed."
            }
            .to_owned(),
        ),
        "resolve" => (
            "resolve",
            json!({"targetId":action.id,"content":content}),
            "Thread resolved.".into(),
        ),
        "reply" => (
            "scoped-reply",
            json!({"parentId":action.id,"message":action.message,"content":content}),
            "o8 replied to this note.".into(),
        ),
        "act" => {
            let note = super::super::spec_rfm::parse(content)
                .notes
                .into_iter()
                .find(|n| n.id == action.id)
                .ok_or("Note no longer exists.")?;
            let prompt = format!(
                "Carry out this accepted o8.md annotation as one scoped action. Do not rerun the full o8.md review or regenerate other annotations.\n\nAnnotation: {}\nAnchor: {}\n\nUse the repository state to decide the concrete action. If the note recommends tracking work, file the appropriate ticket. If it recommends a code or documentation change, implement and verify that change. Keep the work limited to this annotation.",
                if note.text.is_empty() {
                    "Suggested edit"
                } else {
                    &note.text
                },
                if note.anchor.is_empty() {
                    "(no literal anchor)"
                } else {
                    &note.anchor
                }
            );
            let body = json!({"clientMutationId":format!("next-note-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()),"repoPath":repo,"prompt":prompt,"taskName":format!("Act on o8.md note {}",action.id)});
            let deadline = Instant::now() + Duration::from_secs(300);
            let receipt = loop {
                let result = io::json_request(
                    client,
                    "POST",
                    "/api/orchestrator/delegate",
                    &[],
                    Some(body.clone()),
                );
                if let Ok((status, value)) = result {
                    let result = value.get("result").unwrap_or(&value);
                    let progress = result["outcomeUnknown"] != true
                        && (status == 202
                            || result["inProgress"] == true
                            || result["status"] == "in_progress");
                    if status >= 300 || !progress {
                        break value;
                    }
                }
                if Instant::now() >= deadline {
                    return Err("The action is still running, but its final receipt is temporarily unavailable.".into());
                }
                std::thread::sleep(Duration::from_millis(750));
            };
            let awaiting =
                receipt["status"] == "pending_approval" && receipt["approvalId"].is_string();
            if receipt["outcomeUnknown"] == true || receipt["ok"] != true && !awaiting {
                return Err(receipt["error"]
                    .as_str()
                    .or(receipt["note"].as_str())
                    .unwrap_or("Unable to dispatch this note.")
                    .into());
            }
            let id = if awaiting {
                receipt["approvalId"].as_str()
            } else {
                receipt["packetId"].as_str()
            }
            .unwrap_or("scoped action");
            (
                "resolve",
                json!({"targetId":action.id,"content":content,"summary":format!("Accepted; {} {id}",if awaiting{"awaiting approval"}else{"dispatched"})}),
                if awaiting {
                    "Action is awaiting approval.".into()
                } else {
                    format!("Action dispatched as {id}.")
                },
            )
        }
        _ => return Err("Unknown note action".into()),
    };
    let body = post(client, repo, route, payload)?;
    let (status, fresh) =
        io::json_request(client, "GET", "/api/repo-spec", &[("repoPath", repo)], None)?;
    if status >= 300 || fresh["ok"] != true {
        return Err(
            "Action saved, but its content hash could not be refreshed. Reload before editing."
                .into(),
        );
    }
    if fresh["content"] != body["content"] {
        return Err("Notes changed again after the action. Reload before editing.".into());
    }
    Ok((fresh, message))
}
