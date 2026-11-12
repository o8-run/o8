//! Activity decisions and replay of persisted receipts.
use super::*;

impl ActivityPane {
    pub(super) fn mutate(
        &mut self,
        method: &'static str,
        path: &'static str,
        body: Value,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        if self
            .unsettled
            .as_ref()
            .is_some_and(|(_, unsettled, replay)| {
                !RECEIPTS.contains(&path) || (*unsettled, replay) != (path, &body)
            })
        {
            self.notice_error = true;
            self.notice = "An earlier decision is unsettled. Refresh to check it.".into();
            self.changed(cx);
            return;
        }
        self.unsettled = None;
        self.pending = true;
        self.notice_error = false;
        self.notice = if path == packet_merge::PATH {
            "Merging packet…"
        } else {
            "Applying decision…"
        }
        .into();
        let merge = body["verb"] == "merge";
        let replay = body.clone();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(300);
            loop {
                let result = if path == packet_merge::PATH {
                    packet_merge::request(&client, &body)
                } else {
                    client.activity_request(method, path, &[], Some(&body))
                };
                if !RECEIPTS.contains(&path) {
                    break result;
                }
                match &result {
                    Ok(value) if value["outcomeUnknown"] == true => break result,
                    Ok(value)
                        if value["ok"].is_boolean()
                            && value["inProgress"] != true
                            && value["result"]["inProgress"] != true
                            && value["status"] != "in_progress"
                            && value["result"]["status"] != "in_progress" =>
                    {
                        break result;
                    }
                    Err(error) if error.status.is_some() => break result,
                    _ => {}
                }
                if Instant::now() >= deadline {
                    break Ok(json!({"outcomeUnknown":true}));
                }
                // The same exact body polls the persisted receipt; it cannot
                // create another operation while the first is uncertain.
                std::thread::sleep(Duration::from_millis(750));
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                this.notice_error = result.is_err();
                this.notice = match result {
                    Ok(value)
                        if value["result"]["inProgress"] == true
                            || value["outcomeUnknown"] == true =>
                    {
                        this.unsettled = Some((method, path, replay));
                        this.archive_after_stop = None;
                        if path == packet_merge::PATH {
                            value["note"]
                                .as_str()
                                .unwrap_or("Packet merge is unsettled. Refresh to check it.")
                                .into()
                        } else {
                            "Decision is unsettled. Refresh to check it.".into()
                        }
                    }
                    Ok(value) => {
                        // Archive only after the worker has stopped, so a running
                        // agent never disappears from Workers while it edits.
                        if let Some(id) = this.archive_after_stop.take() {
                            this.packet_patch(&id, json!({"archivedAt": packet::iso_now()}), cx);
                        }
                        this.stop_identity = None;
                        this.closing = None;
                        this.close_stage = None;
                        // A created PR's note carries its URL.
                        let (note, fallback) = if path == packet_merge::PATH {
                            (&value["result"]["note"], "Packet merged.")
                        } else {
                            (&value["note"], "Decision applied.")
                        };
                        note.as_str()
                            .filter(|note| !note.is_empty())
                            .map_or_else(|| fallback.into(), String::from)
                    }
                    Err(error) => {
                        this.archive_after_stop = None;
                        if error.status.is_some() {
                            this.stop_identity = None;
                        }
                        this.close_stage = None;
                        if merge && error.message.to_lowercase().contains("conflict") {
                            format!("{} Try \"Create PR\" instead.", error.message)
                        } else {
                            error.message
                        }
                    }
                };
                this.load(cx);
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
}
