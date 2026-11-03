use super::*;
use crate::theme::current as theme;

#[path = "composer/command_client.rs"]
mod command_client;
#[path = "composer/card.rs"]
mod composer_card;
#[path = "composer/picker.rs"]
mod composer_picker;
#[path = "composer/screenshots.rs"]
mod composer_screenshots;
#[path = "composer/selector.rs"]
mod composer_selector;
#[path = "composer/dictation_wave.rs"]
pub(super) mod dictation_wave;
#[path = "composer/prompt_actions.rs"]
mod prompt_actions;
#[path = "composer/prompt_controls.rs"]
mod prompt_controls;
#[path = "composer/prompt_rules.rs"]
mod prompt_rules;
#[path = "composer/prompt_view.rs"]
mod prompt_view;
#[path = "composer/send_menu.rs"]
mod send_menu;

#[cfg(test)]
#[path = "composer/card_tests.rs"]
mod card_tests;
#[cfg(test)]
#[path = "composer/network_tests.rs"]
mod network_tests;
#[path = "composer/queue_tail.rs"]
mod queue_rows;
pub(super) use queue_rows::queue_tail;

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
    fn retire_pending_send(&mut self, thread: &str, id: &Value) {
        if self
            .pending
            .get(thread)
            .is_some_and(|pending| pending["id"] == *id)
        {
            self.pending.remove(thread);
        }
    }
    pub(super) fn send(&mut self, promote: Option<String>, cx: &mut Context<Self>) {
        if promote.is_none()
            && self
                .routing
                .as_ref()
                .is_none_or(|r| r["source"] != "bot-network")
        {
            let editor = self.composer.clone();
            let input = editor.read(cx);
            let raw = input.text.trim().to_owned();
            let expanded = input
                .controls
                .prompt
                .command_wire
                .as_ref()
                .is_some_and(|(text, _)| *text == raw);
            if !expanded
                && let Some(line) = crate::composer::commands::shell_line(raw.as_str())
                && let Some(window) = input.controls.slash.window
            {
                let line = line.to_owned();
                editor.update(cx, |i, cx| i.set_text("", cx));
                cx.defer(move |cx| {
                    let _ = window.update(cx, |_, window, cx| {
                        crate::ui::run_shell_line(line, window, cx);
                    });
                });
                return;
            }
            if !expanded && crate::composer::commands::recognized(raw.as_str()) {
                if self.saving || input.controls.busy || input.controls.slash.scheduled {
                    return;
                }
                if let Some(window) = input.controls.slash.window {
                    editor.update(cx, |i, _| i.controls.slash.scheduled = true);
                    let owner = cx.entity().downgrade();
                    cx.defer(move |cx| {
                        let _ = window.update(cx, |_, window, cx| {
                            let _ = owner.update(cx, |s, cx| {
                                editor.update(cx, |i, _| i.controls.slash.scheduled = false);
                                if s.composer == editor && editor.read(cx).text.trim() == raw {
                                    s.execute_composer_command(raw, window, cx);
                                }
                            });
                        });
                    });
                    return;
                }
            }
        }
        self.mutate_message(promote, false, cx);
    }
    pub(super) fn remove_queued(&mut self, id: String, cx: &mut Context<Self>) {
        self.mutate_message(Some(id), true, cx);
    }
    pub(crate) fn voice(&self) -> VoiceState {
        self.voice
    }
    pub(crate) fn dictation(&self) -> DictationState {
        self.dictation
    }
    pub(crate) fn set_dictation(&mut self, dictation: DictationState, cx: &mut Context<Self>) {
        if self.dictation != dictation {
            self.dictation = dictation;
            if dictation == DictationState::Off {
                self.wave.borrow_mut().reset();
            }
            cx.notify();
        }
    }
    /// The draft dictation starts from.
    pub(crate) fn draft(&self, cx: &App) -> String {
        self.composer.read(cx).text.clone()
    }
    /// A dictation snapshot in the composer, or the draft back after a cancel.
    pub(crate) fn dictate(&mut self, text: &str, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.show_dictation(text, cx));
    }
    /// The final transcript, sent through this chat's own send. One undo step
    /// returns the composer to the draft dictation started from.
    pub(crate) fn send_dictated(&mut self, draft: &str, text: &str, cx: &mut Context<Self>) {
        self.composer.update(cx, |composer, cx| {
            composer.show_dictation(draft, cx);
            composer.set_text(text, cx);
        });
        self.send(None, cx);
    }
    pub(crate) fn set_voice(&mut self, voice: VoiceState, cx: &mut Context<Self>) {
        if self.voice != voice {
            self.voice = voice;
            cx.notify();
        }
    }
    /// The selected chat's Live voice binding (ManagedChatVoiceEntry's
    /// identity): who, which repository and thread, and how it runs. A change
    /// closes the voice session it pinned.
    pub(crate) fn voice_binding(&self, cx: &App) -> Option<VoiceTarget> {
        if self
            .routing
            .as_ref()
            .is_some_and(|r| r["source"] == "bot-network")
        {
            return None;
        }
        let session = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())?;
        let repo = session.repo_path.clone()?;
        let routing = self.composer_routing(cx)?;
        let binding = json!([
            "local",
            repo,
            session.id,
            routing["backend"],
            routing["model"],
            routing["effort"],
            routing["permissionMode"],
            routing["pickedMode"]
        ])
        .to_string();
        Some(VoiceTarget {
            binding,
            thread: session.id.clone(),
            repo,
            backend: routing["backend"].as_str().map(String::from),
        })
    }
    /// A spoken cancel: the desktop stop pill's interrupt for this chat's turn.
    /// Resolves once the server has the request, not when the turn stops.
    pub(crate) fn interrupt_turn(
        &self,
        target: &VoiceTarget,
        cx: &App,
    ) -> gpui::Task<Result<(), String>> {
        let (client, target) = (self.client.clone(), target.clone());
        cx.background_executor().spawn(async move {
            crate::transport::interrupt(
                &client,
                &target.repo,
                &target.thread,
                target.backend.as_deref(),
            )
            .map(drop)
        })
    }
    /// Sends a Live delegation as a new message through this chat's queue,
    /// leaving the draft alone. Resolves to the queue item id once the
    /// receipt matches; acceptance is not completion.
    pub(crate) fn send_spoken(
        &mut self,
        text: String,
        voice: &str,
        cx: &mut Context<Self>,
    ) -> Result<gpui::Task<Result<String, String>>, String> {
        if !self.queue_ready {
            return Err("This chat's queue is not ready.".into());
        }
        let session = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
            .cloned()
            .ok_or("No chat is selected.")?;
        let repo = session
            .repo_path
            .clone()
            .ok_or("This chat has no repository.")?;
        let routing = self
            .composer_routing(cx)
            .ok_or("This chat's routing is not loaded.")?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // The broker admits only queue items named for the Live session's nonce.
        let id = format!("next-{voice}-{nonce:x}");
        let wire = crate::composer::controls::wire(
            &text,
            routing["pickedMode"].as_str().unwrap_or("fast"),
        );
        let body = json!({"repoPath":repo,"threadId":session.id,"id":id,"intent":"send-next",
            "payload":{"text":text,"wireMessage":wire,"images":[],"routing":routing}});
        let client = self.client.clone();
        Ok(cx.spawn(async move |this, cx| {
            let sent = body.clone();
            let receipt = cx
                .background_executor()
                .spawn(async move { client.mutate_queue("POST", &sent) })
                .await
                .map_err(|error| error.message)?;
            if !receipt_matches("POST", &body, &receipt) {
                return Err("The chat did not confirm the spoken request.".into());
            }
            let _ = this.update(cx, |this, cx| this.reconcile(cx));
            Ok(id)
        }))
    }
    fn mutate_message(&mut self, promote: Option<String>, remove: bool, cx: &mut Context<Self>) {
        if !remove && !self.network_can_reply() {
            self.notice =
                "This exchange is read only or closed. Open an operator conversation to reply."
                    .into();
            cx.notify();
            return;
        }
        if self.saving
            || !self.queue_ready
            || (promote.is_none()
                && (self.composer.read(cx).composing()
                    || self.composer.read(cx).controls.busy
                    || self.composer.read(cx).controls.pending_images > 0))
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
        let files = self.composer.read(cx).controls.files.clone();
        // Match the default composer's attachment-only queue payload.
        let text = if draft.trim().is_empty()
            && files.is_empty()
            && !self.composer.read(cx).controls.images.is_empty()
        {
            "[Image attached]".to_owned()
        } else if files.is_empty() {
            draft.trim().to_owned()
        } else {
            // Attached files travel as paths the agent opens from disk.
            [draft.trim(), &crate::composer::images::file_lines(&files)]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n\n")
        };
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
                if pending["payload"]["wireMessage"].is_null() {
                    self.notice = "Mentioned thread context is loading.".into();
                    cx.notify();
                    return;
                }
                if pending["payload"]["text"] != text {
                    self.notice = "An earlier send is unconfirmed. Restore that draft to retry its saved identity, or inspect the shared queue.".into();
                    cx.notify();
                    return;
                }
                ("POST", pending.clone())
            } else {
                let Some(mut routing) = self.composer_routing(cx) else {
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
                let advice = &self.composer.read(cx).controls.prompt;
                let explicit_fleet = advice
                    .command_wire
                    .as_ref()
                    .is_some_and(|(raw, _)| raw == &text)
                    && text.split_whitespace().next().is_some_and(|token| {
                        token.eq_ignore_ascii_case("/orchestrate")
                            || token.eq_ignore_ascii_case("/fleet")
                    });
                if explicit_fleet {
                    routing["mode"] = json!("fleet");
                    routing["pickedMode"] = json!("multitask");
                }
                let contextual = if advice.repo.is_some() || !advice.branch.is_empty() {
                    format!(
                        "Intent scope: repository {} · base branch {}.\n\n{contextual}",
                        advice.repo.as_deref().unwrap_or(&repo),
                        if advice.branch.is_empty() {
                            "main"
                        } else {
                            &advice.branch
                        }
                    )
                } else {
                    contextual
                };
                let contextual = if advice.prelude.is_empty() {
                    contextual
                } else {
                    format!("{}\n\n{contextual}", advice.prelude)
                };
                let wire = if routing["source"] == "bot-network" {
                    text.clone()
                } else if let Some((_, wire)) =
                    advice.command_wire.as_ref().filter(|(raw, _)| raw == &text)
                {
                    if explicit_fleet {
                        crate::composer::controls::wire(wire, "multitask")
                    } else {
                        wire.clone()
                    }
                } else if text.starts_with('/') && !self.linked_issues.contains_key(&session.id) {
                    text.clone()
                } else {
                    crate::composer::controls::wire(
                        &contextual,
                        routing["pickedMode"].as_str().unwrap_or("fast"),
                    )
                };
                let images = self.composer.read(cx).controls.images.clone();
                let body = json!({"repoPath":repo,"threadId":session.id,"id":format!("next-{nonce:x}-{:x}", std::process::id()),
                    "intent":if !self.send_next && self.queue["canSteer"] == true { "steer-now" } else { "send-next" },
                    "payload":{"text":text,"wireMessage":wire,"images":images,"routing":routing}});
                let network_send = routing["source"] == "bot-network";
                let frozen_prelude = advice.prelude.clone();
                if !network_send {
                    self.composer.update(cx, |i, _| {
                        i.controls.prompt.queued_prelude = body["id"]
                            .as_str()
                            .map(|id| (id.to_owned(), frozen_prelude));
                    });
                }
                self.pending.insert(session.id.clone(), body.clone());
                ("POST", body)
            }
        };
        self.generation += 1;
        let generation = self.generation;
        self.saving = true;
        if !remove && self.following.is_none() {
            self.following = Some(self.rows.len());
        }
        self.notice = if remove {
            "Removing queued message…"
        } else {
            "Saving message…"
        }
        .into();
        cx.notify();
        let client = self.client.clone();
        let sent_prelude = self
            .composer
            .read(cx)
            .controls
            .prompt
            .queued_prelude
            .as_ref()
            .filter(|(id, _)| body["id"].as_str() == Some(id.as_str()))
            .map(|(_, prelude)| prelude.clone());
        let sent_images = body["payload"]["images"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let network_send = body["payload"]["routing"]["source"] == "bot-network";
        let request_identity = (session.id.clone(), body["id"].clone());
        let picks = if method == "POST" && fresh {
            self.composer.update(cx, |i, _| i.thread_mentions())
        } else {
            Vec::new()
        };
        let context = if picks.is_empty() {
            None
        } else {
            // A retry must wait until the initial read has frozen the wire prompt.
            self.pending.get_mut(&session.id).unwrap()["payload"]["wireMessage"] = Value::Null;
            let (client, sessions, source) =
                (client.clone(), self.sessions.clone(), session.clone());
            Some(cx.background_executor().spawn(async move {
                crate::composer::mention::thread_context(&client, picks, sessions, source)
            }))
        };
        cx.spawn(async move |this, cx| {
            let mut body = body;
            if let Some(context) = context {
                let context = context.await;
                let wire = body["payload"]["wireMessage"].as_str().unwrap_or_default();
                body["payload"]["wireMessage"] = json!(format!("{wire}\n\n{context}"));
                let _ = this.update(cx, |s, _| {
                    if let Some(pending) = s.pending.get_mut(&request_identity.0)
                        && pending["id"] == request_identity.1
                    {
                        *pending = body.clone();
                    }
                });
            }
            let result = cx
                .background_executor()
                .spawn(async move {
                    let response = client.mutate_queue(method, &body).map_err(|error| {
                        let terminal = error.network_send.as_ref().is_some_and(|receipt| {
                            receipt["id"] == body["id"]
                                && receipt["threadId"] == session.id
                                && matches!(
                                    receipt["status"].as_str(),
                                    Some("accepted" | "cancelled" | "rejected")
                                )
                        });
                        (
                            error.message,
                            error.status.is_some_and(|code| (400..500).contains(&code)),
                            terminal,
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
                            false,
                        ));
                    }
                    let queue = client.queue(&session);
                    let history = client.history(&session.id);
                    Ok::<_, (String, bool, bool)>((method, session, queue, history))
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if result.is_ok()
                    || result
                        .as_ref()
                        .err()
                        .is_some_and(|(_, rejected, terminal)| {
                            *terminal || (method == "POST" && fresh && *rejected)
                        })
                {
                    this.retire_pending_send(&request_identity.0, &request_identity.1);
                }
                if this.generation != generation {
                    return;
                }
                this.saving = false;
                match result {
                    Ok((method, session, queue, history)) => {
                        if method == "POST" {
                            if !network_send {
                                this.composer.update(cx, |i, _| {
                                    if let Some(sent) =
                                        sent_prelude.as_ref().filter(|sent| !sent.is_empty())
                                    {
                                        if i.controls.prompt.prelude == *sent {
                                            i.controls.prompt.prelude.clear();
                                        } else if let Some(remaining) = i
                                            .controls
                                            .prompt
                                            .prelude
                                            .strip_prefix(&format!("{sent}\n\n"))
                                        {
                                            i.controls.prompt.prelude = remaining.to_owned();
                                        }
                                        if let Err(error) =
                                            crate::composer::mode_store::save_prelude(
                                                i.controls.prompt.store.as_deref(),
                                                &i.controls.prompt.prelude,
                                            )
                                        {
                                            i.controls.error = error;
                                        }
                                    }
                                    i.controls.prompt.queued_prelude = None;
                                    i.controls.prompt.command_wire = None;
                                });
                            }
                            this.composer.update(cx, |i, cx| {
                                if i.text == draft {
                                    i.clear(cx);
                                }
                                i.controls
                                    .images
                                    .retain(|image| !sent_images.contains(image));
                                i.controls.files.retain(|file| !files.contains(file));
                                cx.notify();
                            });
                        }
                        // The queue rows under the composer show delivery, as on
                        // the desktop; the transcript keeps no confirmation line.
                        this.notice.clear();
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
                    Err((error, _, _)) => {
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
        let rise = self.composer.read(cx).rise(window);
        div()
            .w_full()
            .max_w(px(crate::theme::chat_width()))
            .mx_auto()
            // A growing draft lifts the card over the transcript rather than
            // shrinking it, so the transcript region is reused while typing.
            .mt(px(-rise))
            .flex()
            .flex_col()
            .children(self.lineage_strip(cx))
            .child(self.composer_card(window, cx))
            .into_any_element()
    }
    /// Messages still waiting in this chat's queue, oldest first.
    /// Sends still waiting, without the ones the transcript already shows
    /// (ComposerQueuedMessages' pending filter): a message carrying the item's
    /// id, or for an admitted send, the same text saved after it was queued.
    pub(super) fn queued_items(&self) -> Vec<Value> {
        let entries = self
            .transcript
            .as_ref()
            .map(|t| t.shown_entries())
            .unwrap_or_default();
        let shown = |item: &Value| {
            let id = item["id"].as_str().unwrap_or_default();
            let ids = [
                format!("composer-steer-{id}"),
                format!("composer-queued-{id}"),
                format!("review-user-assistant-queued-{id}"),
            ];
            let admitted = item["status"] == "dispatching" && !item["admittedAt"].is_null();
            let created = item["createdAt"].as_f64().unwrap_or(f64::MAX);
            entries.iter().any(|entry| {
                ids.contains(&entry.id)
                    || admitted
                        && entry.role == "user"
                        && item["payload"]["text"] == entry.text.as_str()
                        && entry
                            .extra
                            .get("timestamp")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.)
                            >= created
            })
        };
        self.queue["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item["status"] != "applied" && item["status"] != "cancelled")
                    .filter_map(|item| match (shown(item), item["status"] == "held") {
                        (false, _) => Some(item.clone()),
                        // A held send already in the transcript still blocks
                        // everything after it; keep its reason and Remove, as
                        // classic's tag on that bubble does, without a second bubble.
                        (true, true) => {
                            let mut item = item.clone();
                            item["captionOnly"] = Value::Bool(true);
                            Some(item)
                        }
                        (true, false) => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
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
