use super::*;
use crate::theme::current as theme;

#[path = "composer/card.rs"]
mod composer_card;

#[cfg(test)]
#[path = "composer/card_tests.rs"]
mod card_tests;

// The queue returns realpath(repoPath), while saved histories can retain a
// symlink spelling (notably /var versus /private/var on macOS). Keep the frozen
// request intact for retries and compare actual directory identity on mismatch.
fn receipt_matches(method: &str, body: &Value, response: &Value) -> bool {
    let item = &response["item"];
    let same_repo = match (item["repoPath"].as_str(), body["repoPath"].as_str()) {
        (Some(actual), Some(expected)) if actual == expected => true,
        (Some(actual), Some(expected)) => {
            match (fs::canonicalize(actual), fs::canonicalize(expected)) {
                (Ok(actual), Ok(expected)) => actual == expected,
                _ => false,
            }
        }
        _ => false,
    };
    item["id"] == body["id"]
        && item["threadId"] == body["threadId"]
        && same_repo
        && (method != "POST" || item["payload"] == body["payload"])
        && item["status"] != "cancelled"
}
impl Surface {
    pub(super) fn send(&mut self, promote: Option<String>, cx: &mut Context<Self>) {
        self.mutate_message(promote, false, cx);
    }
    pub(super) fn remove_queued(&mut self, id: String, cx: &mut Context<Self>) {
        self.mutate_message(Some(id), true, cx);
    }
    fn mutate_message(&mut self, promote: Option<String>, remove: bool, cx: &mut Context<Self>) {
        if self.saving
            || !self.queue_ready
            || self.composer.read(cx).composing()
            || self.composer.read(cx).controls.busy
        {
            return;
        }
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
            .cloned()
        else {
            return;
        };
        let Some(repo) = session.repo_path.clone() else {
            return;
        };
        let draft = self.composer.read(cx).text.clone();
        // Match the default composer's attachment-only queue payload.
        let text = if draft.trim().is_empty() && !self.composer.read(cx).controls.images.is_empty()
        {
            "[Image attached]"
        } else {
            draft.trim()
        }
        .to_owned();
        let fresh = !self.pending.contains_key(&session.id);
        let (method, body) = if let Some(id) = promote {
            (
                if remove { "DELETE" } else { "PATCH" },
                json!({"repoPath":repo,"threadId":session.id,"id":id}),
            )
        } else {
            if text.is_empty() {
                return;
            }
            if let Some(pending) = self.pending.get(&session.id) {
                if pending["payload"]["text"] != text {
                    self.notice = "An earlier send is unconfirmed. Restore that draft to retry its saved identity, or inspect the shared queue.".into();
                    cx.notify();
                    return;
                }
                ("POST", pending.clone())
            } else {
                let Some(routing) = self.composer_routing(cx) else {
                    return;
                };
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let linked = self.linked_issues.get(&session.id).map(|i| i.context());
                let contextual = linked
                    .map(|context| format!("{context}\n\n{text}"))
                    .unwrap_or_else(|| text.clone());
                let wire = if text.starts_with('/') && !self.linked_issues.contains_key(&session.id)
                {
                    text.clone()
                } else {
                    crate::composer::controls::wire(
                        &contextual,
                        routing["pickedMode"].as_str().unwrap_or("solo"),
                    )
                };
                let images = self.composer.read(cx).controls.images.clone();
                let body = json!({"repoPath":repo,"threadId":session.id,"id":format!("next-{nonce:x}-{:x}", std::process::id()),
                    "intent":if !self.send_next && self.queue["canSteer"] == true { "steer-now" } else { "send-next" },
                    "payload":{"text":text,"wireMessage":wire,"images":images,"routing":routing}});
                self.pending.insert(session.id.clone(), body.clone());
                ("POST", body)
            }
        };
        self.generation += 1;
        let generation = self.generation;
        self.saving = true;
        self.notice = if remove {
            "Removing queued message…"
        } else {
            "Saving message…"
        }
        .into();
        cx.notify();
        let client = self.client.clone();
        let sent_images = body["payload"]["images"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let task = cx.background_executor().spawn(async move {
            let response = client.mutate_queue(method, &body).map_err(|error| {
                (
                    error.message,
                    error.status.is_some_and(|code| (400..500).contains(&code)),
                )
            })?;
            let matches = if method == "DELETE" {
                response["ok"] == true
            } else {
                receipt_matches(method, &body, &response)
            };
            if !matches {
                return Err((
                    "Message receipt did not match. Draft retained; inspect the shared queue."
                        .into(),
                    false,
                ));
            }
            let queue = client.queue(&session);
            let history = client.history(&session.id);
            Ok::<_, (String, bool)>((method, session, queue, history))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.saving = false;
                match result {
                    Ok((method, session, queue, history)) => {
                        if method == "POST" {
                            this.pending.remove(&session.id);
                            if this.composer.read(cx).text == draft {
                                this.composer.update(cx, |i, cx| {
                                    i.clear(cx);
                                    i.controls
                                        .images
                                        .retain(|image| !sent_images.contains(image));
                                });
                            }
                        }
                        this.notice = if method == "DELETE" {
                            "Queued message removed."
                        } else {
                            "Message saved. Delivery status is shown below."
                        }
                        .into();
                        match queue {
                            Ok(queue) => this.queue = queue,
                            Err(error) => this.notice = error,
                        }
                        match history {
                            Ok(history) => {
                                if let Some(transcript) = &mut this.transcript {
                                    transcript.operator_echoes(history);
                                    let rows = transcript.rows.clone();
                                    this.install_rows(rows, cx);
                                }
                            }
                            Err(error) => this.notice = error,
                        }
                    }
                    Err((error, rejected)) => {
                        if method == "POST" && fresh && rejected {
                            if let Some(id) = &this.selected {
                                this.pending.remove(id);
                            }
                        }
                        this.notice = error;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn reconcile(&mut self, cx: &mut Context<Self>) {
        if self.saving || !self.queue_ready {
            return;
        }
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
            .cloned()
        else {
            return;
        };
        let generation = self.generation;
        let captured = self.transcript.as_ref().map(|t| t.checkpoint());
        self.reconcile_revision += 1;
        let revision = self.reconcile_revision;
        let client = self.client.clone();
        let embedded_sessions = self.embedded.then(|| self.sessions.clone());
        let task = cx.background_executor().spawn(async move {
            Ok::<_, String>((
                match embedded_sessions {
                    Some(sessions) => sessions,
                    None => client.sessions()?,
                },
                client.queue(&session)?,
                client.history(&session.id)?,
            ))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation || revision != this.reconcile_revision {
                    return;
                }
                let mut changed;
                match result {
                    Ok((sessions, queue, history)) => {
                        changed = this.sessions != sessions || this.queue != queue;
                        this.sessions = sessions;
                        this.queue = queue;
                        if let Some(transcript) = &mut this.transcript {
                            if captured.is_some_and(|stamp| transcript.saved_tail(history, stamp)) {
                                changed = true;
                                let rows = transcript.rows.clone();
                                this.install_rows(rows, cx);
                            }
                        }
                    }
                    Err(error) => {
                        let notice = format!("{error}. Refresh to retry.");
                        changed = this.notice != notice;
                        this.notice = notice;
                    }
                }
                if changed {
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(super) fn composer_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let enabled = self.queue_ready && !self.saving;
        let queue = self.queue["items"].as_array().cloned().unwrap_or_default();
        let queue = queue
            .into_iter()
            .filter(|item| item["status"] != "applied" && item["status"] != "cancelled")
            .collect::<Vec<_>>();
        div()
            .w_full()
            .max_w(px(crate::theme::GEOMETRY.composer_width))
            .mx_auto()
            .flex()
            .flex_col()
            .gap(px(if queue.is_empty() { 0. } else { 8. }))
            .child(self.composer_card(window, cx))
            .child(
                div()
                    .id("composer-queue")
                    .max_h(px(120.))
                    .overflow_y_scroll()
                    .children(queue.into_iter().map(|item| {
                        let id = item["id"].as_str().unwrap_or("").to_owned();
                        let remove_id = id.clone();
                        let cancellable = enabled
                            && (item["status"] == "queued"
                                || item["status"] == "held"
                                || (item["status"] == "dispatching"
                                    && item["admittedAt"].is_null()));
                        let steerable = enabled
                            && item["status"] == "queued"
                            && item["intent"] == "send-next"
                            && item["admittedAt"].is_null()
                            && item["payload"]["afterTaskId"].is_null()
                            && self.queue["steerableIds"]
                                .as_array()
                                .is_some_and(|ids| ids.iter().any(|v| v == &id));
                        div()
                            .flex()
                            .flex_col()
                            .text_size(px(11.))
                            .child(format!(
                                "{} · {}",
                                item["status"].as_str().unwrap_or("queued"),
                                item["payload"]["text"].as_str().unwrap_or("")
                            ))
                            .when(item["reason"].is_string(), |d| {
                                d.child(item["reason"].as_str().unwrap_or("").to_owned())
                            })
                            .when(steerable, |d| {
                                d.child(
                                    div()
                                        .id(gpui::ElementId::Name(format!("steer-{id}").into()))
                                        .debug_selector(|| "steer-now".into())
                                        .cursor_pointer()
                                        .child("Steer now")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.send(Some(id.clone()), cx)
                                        })),
                                )
                            })
                            .when(cancellable, |d| {
                                d.child(
                                    div()
                                        .id(gpui::ElementId::Name(
                                            format!("remove-{remove_id}").into(),
                                        ))
                                        .debug_selector(|| "remove-queued".into())
                                        .cursor_pointer()
                                        .child("Remove")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.remove_queued(remove_id.clone(), cx)
                                        })),
                                )
                            })
                    })),
            )
            .into_any_element()
    }
}

#[cfg(all(test, unix))]
mod receipt_tests {
    use super::*;

    #[test]
    fn canonical_receipt_keeps_request_session_payload_and_repository_fences() {
        let root = std::env::temp_dir().join(format!(
            "o8-next-receipt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let repo = root.join("repo");
        let other = root.join("other");
        let alias = root.join("alias");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&other).unwrap();
        std::os::unix::fs::symlink(&repo, &alias).unwrap();
        let body = json!({"id":"fixture-id", "threadId":"thoughts-fixture", "repoPath":alias,
            "payload":{"text":"hello"}});
        let mut response = json!({"item":body.clone()});
        response["item"]["repoPath"] = json!(fs::canonicalize(&repo).unwrap());
        response["item"]["status"] = json!("applied");
        assert!(receipt_matches("POST", &body, &response));
        for (key, value) in [
            ("id", json!("other-id")),
            ("threadId", json!("thoughts-other")),
            ("payload", json!({"text":"other"})),
            ("status", json!("cancelled")),
            ("repoPath", json!(other)),
            ("repoPath", json!(root.join("missing"))),
            ("repoPath", Value::Null),
        ] {
            let mut wrong = response.clone();
            wrong["item"][key] = value;
            assert!(!receipt_matches("POST", &body, &wrong), "{key}");
        }
        assert_eq!(
            body["repoPath"],
            json!(alias),
            "retry identity stays frozen"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
