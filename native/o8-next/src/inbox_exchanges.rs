use super::*;
use serde_json::json;

#[derive(Clone, Default, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentExchange {
    pub id: String,
    pub repo: String,
    pub participants: Vec<String>,
    pub status: String,
    pub summary: Option<String>,
    pub remaining_turns: u64,
    pub revision: u64,
}
#[derive(Clone)]
pub(crate) struct ExchangeSelection {
    pub repo: String,
    pub id: String,
}
pub(crate) struct ExchangeChanged;
impl EventEmitter<ExchangeChanged> for Inbox {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    conversations: Vec<AgentExchange>,
    next_cursor: Option<String>,
}
#[derive(Clone, Deserialize)]
pub(super) struct Detail {
    pub conversation: AgentExchange,
    pub messages: Vec<Value>,
}
#[derive(Clone)]
pub(super) struct Undo {
    pub target: ExchangeSelection,
    pub receipt: Value,
}
#[derive(Clone)]
pub(super) struct PendingClose {
    target: ExchangeSelection,
    mutation: String,
    revision: u64,
}
#[derive(Default)]
pub(super) struct State {
    pub rows: Vec<AgentExchange>,
    pub detail: Option<Detail>,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub busy: bool,
    pub expanded: bool,
    pub undo: Option<Undo>,
    pub pending: Option<PendingClose>,
    selection: u64,
    loading: bool,
    refreshed: Option<Instant>,
}
pub(super) struct ActionError {
    message: String,
    uncertain: bool,
}
impl Client {
    pub(crate) fn agent_exchanges(
        &self,
        workspace: Option<&str>,
        closed: bool,
    ) -> Result<Vec<AgentExchange>, String> {
        let mut out = Vec::new();
        let mut cursor = None::<String>;
        let mut seen = HashSet::new();
        loop {
            let mut query = vec![
                ("status", if closed { "closed" } else { "open" }),
                ("limit", "100"),
            ];
            match workspace.filter(|repo| !repo.is_empty()) {
                Some(repo) => query.push(("repo", repo)),
                None => query.push(("scope", "all")),
            }
            if let Some(cursor) = cursor.as_deref() {
                query.push(("cursor", cursor));
            }
            let page: Page = self.get("/api/agents/conversation", &query)?;
            for row in page.conversations {
                if (row.status == "closed") != closed {
                    return Err("The server does not support complete exchange listing.".into());
                }
                out.push(row);
            }
            // The Settled shelf is a bounded recent history; Active is complete.
            if closed {
                break;
            }
            cursor = page.next_cursor;
            let Some(next) = cursor.as_ref() else {
                break;
            };
            if !seen.insert(next.clone()) {
                return Err("Exchange pagination did not advance. Refresh before acting.".into());
            }
        }
        Ok(out)
    }
    fn exchange_action(&self, body: Value) -> Result<Value, ActionError> {
        let url = self.url("/api/agents/conversation").unwrap();
        let response = self
            .request("POST", &url)
            .send_json(body.clone())
            .map_err(|error| match error {
                ureq::Error::Status(status, response) => {
                    let record = Self::read::<Value>(response).unwrap_or_default();
                    ActionError {
                        message: record["error"]["message"]
                            .as_str()
                            .unwrap_or(
                                "Exchange action was refused. Refresh before another action.",
                            )
                            .into(),
                        uncertain: status >= 500,
                    }
                }
                _ => ActionError {
                    message: "Exchange action is unconfirmed. Refresh or retry the same action."
                        .into(),
                    uncertain: true,
                },
            })?;
        let record: Value = Self::read(response).map_err(|message| ActionError {
            message,
            uncertain: true,
        })?;
        let status = if body["action"] == "undo-close" {
            "open"
        } else {
            "closed"
        };
        if record["ok"] != true
            || record["conversation"]["id"] != body["id"]
            || record["conversation"]["repo"] != body["repo"]
            || record["conversation"]["status"] != status
        {
            return Err(ActionError {
                message: "Exchange action returned no matching confirmation. Refresh or retry."
                    .into(),
                uncertain: true,
            });
        }
        Ok(record)
    }
}
impl Inbox {
    pub(super) fn refresh_exchanges(&mut self, cx: &mut Context<Self>) {
        if self.loading
            || self.exchanges.loading
            || self
                .exchanges
                .refreshed
                .is_some_and(|at| at.elapsed() < Duration::from_secs(5))
        {
            return;
        }
        self.exchanges.loading = true;
        self.exchanges.refreshed = Some(Instant::now());
        let revision = self.revision;
        let client = self.client.clone();
        let workspace = (!self.all).then(|| self.workspace.clone());
        let task = cx.background_executor().spawn(async move {
            let mut rows = client.agent_exchanges(workspace.as_deref(), false)?;
            rows.extend(client.agent_exchanges(workspace.as_deref(), true)?);
            Ok::<_, String>(rows)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.exchanges.loading = false;
                if revision != this.revision {
                    this.exchanges.refreshed = None;
                    return;
                }
                match result {
                    Ok(rows) => this.exchange_rows(rows, cx),
                    Err(error) => this.exchanges.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn exchange_rows(&mut self, rows: Vec<AgentExchange>, cx: &mut Context<Self>) {
        let before: Vec<_> = self
            .exchanges
            .rows
            .iter()
            .map(|row| (&row.id, &row.repo, &row.status, row.revision))
            .collect();
        let after: Vec<_> = rows
            .iter()
            .map(|row| (&row.id, &row.repo, &row.status, row.revision))
            .collect();
        let changed = before != after;
        let refresh_detail = self
            .exchanges
            .detail
            .as_ref()
            .and_then(|detail| {
                rows.iter().find(|row| {
                    row.id == detail.conversation.id
                        && row.repo == detail.conversation.repo
                        && row.revision != detail.conversation.revision
                })
            })
            .map(|row| ExchangeSelection {
                id: row.id.clone(),
                repo: row.repo.clone(),
            });
        self.exchanges.rows = rows;
        self.exchanges.error = None;
        self.exchanges.refreshed = Some(Instant::now());
        if let Some(target) = refresh_detail {
            self.select_exchange(target, cx);
        }
        if changed {
            cx.emit(ExchangeChanged);
        }
    }
    pub(crate) fn select_exchange(&mut self, target: ExchangeSelection, cx: &mut Context<Self>) {
        self.exchanges.selection += 1;
        let selection = self.exchanges.selection;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Detail>(
                "/api/agents/conversation",
                &[("repo", &target.repo), ("id", &target.id)],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if selection != this.exchanges.selection {
                    return;
                }
                match result {
                    Ok(detail) => {
                        this.exchanges.detail = Some(detail);
                        this.exchanges.error = None;
                    }
                    Err(error) => this.exchanges.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn settle_exchange(&mut self, row: AgentExchange, cx: &mut Context<Self>) {
        if self.exchanges.busy {
            return;
        }
        let pending = match self.exchanges.pending.clone() {
            Some(pending) if pending.target.id == row.id && pending.target.repo == row.repo => {
                pending
            }
            Some(_) => {
                self.exchanges.notice =
                    Some("Retry the unconfirmed Settle before settling another exchange.".into());
                cx.notify();
                return;
            }
            None => PendingClose {
                target: ExchangeSelection {
                    repo: row.repo,
                    id: row.id,
                },
                revision: row.revision,
                mutation: format!(
                    "exchange-close-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ),
            },
        };
        self.exchanges.pending = Some(pending.clone());
        self.exchanges.undo = None;
        self.exchanges.busy = true;
        self.exchanges.error = None;
        self.exchanges.notice = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let result = client.exchange_action(json!({"repo":pending.target.repo,"id":pending.target.id,"action":"close", "undoable":true,
                "clientMutationId":pending.mutation,"expectedRevision":pending.revision}));
            (pending.target, result)
        });
        cx.spawn(async move |this, cx| {
            let (target, result) = task.await;
            let _ = this.update(cx, |this, cx| {
                this.exchanges.busy = false;
                match result {
                    Ok(record) => {
                        if !record["undo"].is_null() {
                            this.exchanges.undo = Some(Undo {
                                target,
                                receipt: record["undo"].clone(),
                            });
                        }
                        this.exchanges.pending = None;
                        this.revision += 1;
                        this.load(cx);
                    }
                    Err(error) => {
                        if !error.uncertain {
                            this.exchanges.pending = None;
                            this.revision += 1;
                            this.load(cx);
                        }
                        this.exchanges.notice = Some(error.message);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn retry_exchange_close(&mut self, cx: &mut Context<Self>) {
        if let Some(pending) = self.exchanges.pending.clone() {
            self.settle_exchange(
                AgentExchange {
                    id: pending.target.id,
                    repo: pending.target.repo,
                    revision: pending.revision,
                    ..Default::default()
                },
                cx,
            );
        }
    }
    pub(super) fn undo_exchange(&mut self, cx: &mut Context<Self>) {
        if self.exchanges.busy {
            return;
        }
        let Some(undo) = self.exchanges.undo.clone() else {
            return;
        };
        self.exchanges.busy = true;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.exchange_action(json!({"repo":undo.target.repo,"id":undo.target.id,"action":"undo-close","undo":undo.receipt}))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.exchanges.busy = false;
                match result {
                    Ok(_) => {
                        this.exchanges.undo = None;
                        this.exchanges.notice = None;
                        this.revision += 1;
                        this.load(cx);
                    }
                    Err(error) => {
                        if !error.uncertain {
                            this.exchanges.undo = None;
                        }
                        this.exchanges.notice = Some(error.message);
                        this.revision += 1;
                        this.load(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn exchange_undo_key(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = &event.keystroke;
        let modifier = if cfg!(target_os = "macos") {
            key.modifiers.platform
        } else {
            key.modifiers.control
        };
        if modifier
            && !key.modifiers.shift
            && !key.modifiers.alt
            && key.key == "z"
            && self.focus.contains_focused(window, cx)
            && self.exchanges.undo.is_some()
        {
            self.undo_exchange(cx);
            cx.stop_propagation();
            return true;
        }
        false
    }
}
