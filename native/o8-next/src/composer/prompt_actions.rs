//! Existing classic endpoint calls. Refusals retain the originating draft.
use super::*;
pub(super) fn post(client: &Client, path: &str, body: Value) -> Result<Value, String> {
    let url = client.url(path).map_err(|e| e.to_string())?;
    let response = match client.request("POST", &url).send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => {
            let value = Client::read::<Value>(response).unwrap_or(Value::Null);
            return Err(value["error"]
                .as_str()
                .or(value["error"]["message"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("The server refused this request (HTTP {code}).")));
        }
        Err(error) => return Err(error.to_string()),
    };
    let value: Value = Client::read(response)?;
    if value["ok"] == false || value["success"] == false || !value["error"].is_null() {
        return Err(value["error"]
            .as_str()
            .or(value["error"]["message"].as_str())
            .unwrap_or("The server did not confirm this action.")
            .to_owned());
    }
    Ok(value)
}
impl Surface {
    pub(super) fn submit_prompt_form(&mut self, cx: &mut Context<Self>) {
        let editor = self.composer.clone();
        let open = editor.read(cx).controls.open.unwrap_or("");
        if editor.read(cx).controls.prompt.loading {
            return;
        }
        let fields: Vec<String> = editor
            .read(cx)
            .controls
            .prompt
            .fields
            .iter()
            .map(|f| f.read(cx).text.trim().to_owned())
            .collect();
        let repo = self.intent_repo(cx).unwrap_or_default();
        let scope = editor.read(cx).controls.prompt.scope;
        if fields.first().is_none_or(|s| s.is_empty())
            || (open == "save-prompt" && fields.get(2).is_none_or(|s| s.is_empty()))
        {
            editor.update(cx, |i, cx| {
                i.controls.prompt.error = "A title/name and prompt body are required.".into();
                cx.notify();
            });
            cx.notify();
            return;
        }
        let client = self.client.clone();
        let branch = fields[0].clone();
        let body = if open == "branch-create" {
            let current = editor.read(cx).controls.prompt.branch_base.clone();
            json!({"path":repo,"branch":branch,"baseBranch":current})
        } else {
            json!({"title":fields[0],"tags":fields.get(1).map(|s|s.split(',').map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>()).unwrap_or_default(),"body":fields.get(2),"scope":if scope{"repo"}else{"global"},"repoPath":if scope{Some(repo)}else{None}})
        };
        let generation = editor.update(cx, |i, cx| {
            i.controls.prompt.loading = true;
            i.controls.prompt.error.clear();
            i.controls.prompt.generation += 1;
            cx.notify();
            i.controls.prompt.generation
        });
        let task = cx.background_executor().spawn(async move {
            post(
                &client,
                if open == "branch-create" {
                    "/api/panel/branches"
                } else {
                    "/api/prompt-library"
                },
                body,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = editor.update(cx, |i, cx| {
                if i.controls.open != Some(open) || i.controls.prompt.generation != generation {
                    return;
                }
                i.controls.prompt.loading = false;
                match result {
                    Ok(value) if open == "branch-create" => {
                        if let Some(created) = value["created"].as_str() {
                            i.controls.prompt.branch = created.to_owned();
                            i.controls.open = None;
                        } else {
                            i.controls.prompt.error =
                                "The server did not confirm the new branch.".into();
                        }
                    }
                    Ok(value) if value["prompt"]["id"].is_string() => {
                        i.controls.prompt.result = if value["created"] == false {
                            "This prompt is already saved in that scope."
                        } else {
                            "Prompt saved."
                        }
                        .into()
                    }
                    Ok(_) => {
                        i.controls.prompt.error =
                            "The server did not confirm the saved prompt.".into()
                    }
                    Err(error) => i.controls.prompt.error = error,
                }
                cx.notify();
            });
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }
    pub(crate) fn execute_composer_command(
        &mut self,
        raw: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.queue_ready || self.saving || self.composer.read(cx).controls.busy {
            return;
        }
        let mut parts = raw.trim().splitn(2, char::is_whitespace);
        let token = parts.next().unwrap_or("").to_lowercase();
        let args = parts.next().unwrap_or("").trim().to_owned();
        let command = match token.as_str() {
            "/visualize" => "/visualization",
            "/fleet" => "/orchestrate",
            _ => token.as_str(),
        };
        if command == "/prompts" {
            self.composer.update(cx, |i, cx| i.set_text("", cx));
            self.open_prompt("prompts", window, cx);
            return;
        }
        if command == "/rules" {
            self.composer.update(cx, |i, cx| i.set_text("", cx));
            self.open_prompt("rules", window, cx);
            return;
        }
        if command == "/ask" {
            if args.is_empty() {
                self.command_help("Ask needs a question.", cx);
                return;
            }
            if !self
                .selected
                .as_ref()
                .is_some_and(|id| self.brains.get(id).is_some_and(|b| b.read(cx).expanded))
            {
                self.toggle_brain(window, cx);
            }
            if let Some(brain) = self.selected.as_ref().and_then(|id| self.brains.get(id)) {
                if brain.read(cx).busy {
                    self.command_help("Brain is already answering. This draft is retained.", cx);
                    return;
                }
                brain.update(cx, |b, cx| b.ask_from_composer(&args, cx));
                self.composer.update(cx, |i, cx| {
                    i.clear(cx);
                    i.controls.prompt.feedback =
                        "Brain request opened in the reading panel.".into();
                });
            }
            return;
        }
        if command == "/visualization" || command == "/orchestrate" {
            if args.is_empty() {
                self.command_help("Add a task after this command.", cx);
                return;
            }
            let prompt = if command == "/visualization" {
                format!(
                    "The user explicitly requested an interactive visualization in this conversation.\nCreate it directly using o8_html_preview, inspect and refine the screenshot and diagnostics, then publish with o8_html_render before the final reply.\nUse the current conversation and supplied attachments as context. Follow the tools' shared design guidance; verify a narrow layout and both appearances.\nChoose a chart, diagram, illustration, or interactive comparison that explains the request. Keep values truthful and label any illustrative data.\nThis is an inline explanation: do not dispatch workers or modify the workspace merely to draw it. Add only useful interpretation after the visual.\n\nUser request:\n{args}"
                )
            } else {
                format!(
                    "Coordinate this task on the current repository. Use the current mission and conversation as context. Review the packet plan and make real tool calls before claiming dispatch.\n\nTask:\n{args}"
                )
            };
            self.composer.update(cx, |i, cx| {
                i.set_text(&raw, cx);
                i.controls.prompt.command_wire = Some((raw.clone(), prompt));
            });
            self.send(None, cx);
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
        if session.repo_path.is_none() {
            return;
        }
        let editor = self.composer.clone();
        let draft = editor.read(cx).text.clone();
        let client = self.client.clone();
        let command = command.to_owned();
        let entries = self
            .transcript
            .as_ref()
            .map(|t| t.shown_entries().to_vec())
            .unwrap_or_default();
        let origin = session.id.clone();
        editor.update(cx, |i, cx| {
            i.controls.busy = true;
            i.controls.error.clear();
            cx.notify();
        });
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let task = cx.background_executor().spawn(async move {
            super::command_client::run(&client, &session, &command, &args, &entries, &routing)
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |s, window, cx| {
                editor.update(cx, |i, cx| {
                    i.controls.busy = false;
                    if let Err(error) = &result {
                        i.controls.error = error.clone();
                    }
                    cx.notify();
                });
                if let Ok(applied) = result {
                    let owns = s.selected.as_ref() == Some(&origin) && s.composer == editor;
                    if let Some((destination, body)) = applied.new_thread {
                        let id = destination.id.clone();
                        s.sessions.retain(|session| session.id != id);
                        s.sessions.insert(0, destination);
                        if owns {
                            editor.update(cx, |i, cx| {
                                if i.text == draft { i.clear(cx); }
                            });
                            s.select(id, cx);
                            s.composer.update(cx, |i, cx| {
                                i.set_text(&body, cx);
                                i.focus.focus(window);
                            });
                        } else {
                            editor.update(cx, |i, cx| {
                                i.controls.prompt.feedback = "A destination draft was created. The original command is retained because the selected conversation changed.".into();
                                cx.notify();
                            });
                        }
                    } else {
                        editor.update(cx, |i, cx| {
                            if i.text == draft { i.clear(cx); }
                            i.controls.prompt.feedback = applied.feedback;
                            if let Some((prelude, append)) = applied.prelude {
                                if append && !i.controls.prompt.prelude.is_empty() {
                                    i.controls.prompt.prelude.push_str("\n\n");
                                    i.controls.prompt.prelude.push_str(&prelude);
                                } else { i.controls.prompt.prelude = prelude; }
                            }
                            if let Err(error) = crate::composer::mode_store::save_prelude(i.controls.prompt.store.as_deref(), &i.controls.prompt.prelude) {
                                i.controls.error = error;
                            }
                            cx.notify();
                        });
                        if owns {
                            if let Some(entries) = applied.entries {
                                if let Some(current) = &s.transcript {
                                    let history = crate::model::History { session_key: current.key.clone(), transcript: entries, page: None };
                                    let transcript = Transcript::new(history);
                                    let rows = transcript.rows.clone();
                                    s.transcript = Some(transcript);
                                    s.install_rows(rows, cx);
                                }
                            }
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn command_help(&self, text: &str, cx: &mut Context<Self>) {
        self.composer.update(cx, |i, cx| {
            i.controls.error = text.into();
            cx.notify();
        });
        cx.notify();
    }
}
