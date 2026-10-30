//! PacketCard state and lazy reads, bound to scope, lane and review identity.
use super::feed::text;
use super::*;
use crate::composer::Composer;
use gpui::{AppContext, Entity};
use std::collections::HashSet;

#[derive(Clone)]
pub(super) enum Command {
    Read(Row),
    Tab(String, &'static str),
    More(String),
    Brief(String),
    Edit(Row, &'static str),
    Cancel,
    Save(Row),
    Patch(Row, Value),
    Diff(Row),
}
#[derive(Clone, Default)]
pub(super) struct Review {
    pub request: u64,
    pub identity: String,
    pub loading: bool,
    pub error: Option<String>,
    pub spec: String,
    pub diff: Value,
    pub directives: Value,
    pub files: Vec<Value>,
}
pub(super) struct Editor {
    pub id: String,
    pub field: &'static str,
    pub input: Entity<Composer>,
    _submit: gpui::Subscription,
}
#[derive(Default)]
pub(super) struct State {
    pub request: u64,
    pub reads: HashMap<String, Review>,
    pub tabs: HashMap<String, &'static str>,
    pub all_files: HashSet<String>,
    pub briefs: HashSet<String>,
    pub editor: Option<Editor>,
    pub action: Option<String>,
}
pub(super) fn identity(row: &Row) -> String {
    json!([
        row.id,
        row.repo,
        row.data["lane"],
        row.data["review"],
        row.data["status"],
        row.data["workspaceTargetPath"]
    ])
    .to_string()
}
fn segment(id: &str) -> String {
    url::form_urlencoded::byte_serialize(id.as_bytes()).collect()
}
fn failure(message: impl Into<String>) -> ReadError {
    ReadError {
        message: message.into(),
        status: Some(409),
        retry: 0,
    }
}
fn checked(value: Value) -> Result<Value, ReadError> {
    if value["ok"] == false || value["result"]["merged"] == false {
        return Err(failure(
            value["note"]
                .as_str()
                .or(value["result"]["note"].as_str())
                .unwrap_or("The server refused this action. Refresh to inspect the packet."),
        ));
    }
    Ok(value)
}
impl ActivityPane {
    pub(super) fn packet_read(&mut self, row: Row, force: bool, cx: &mut Context<Self>) {
        let key = identity(&row);
        if !force
            && self
                .packet
                .reads
                .get(&row.id)
                .is_some_and(|r| r.identity == key)
        {
            return;
        }
        self.packet.request += 1;
        let request = self.packet.request;
        self.packet.reads.insert(
            row.id.clone(),
            Review {
                request,
                identity: key.clone(),
                loading: true,
                ..Review::default()
            },
        );
        let generation = self.generation;
        let client = self.client.clone();
        let task_row = row.clone();
        let task_key = key.clone();
        let task = cx.background_executor().spawn(async move {
            let row = task_row;
            let mut read = Review { request, identity: task_key, ..Review::default() };
            let mut errors = vec![];
            read.spec = ["spec", "prompt", "description", "body"].iter().filter_map(|field| row.data[*field].as_str()).find(|s| !s.is_empty()).unwrap_or("").to_string();
            let repo = text(&row.data,"workspaceTargetPath");
            match client.activity_request("GET", "/api/cortex/directives", &[("repoPath", &repo)], None) {
                Ok(v) => read.directives = v,
                Err(e) => errors.push(format!("Directives: {}",e.message)),
            }
            let lane_id = text(&row.data["lane"], "laneId");
            if !lane_id.is_empty() && row.data["status"] == "awaiting_review" {
                // The existing lane diff includes committed branch work.
                match client.activity_request("GET", &format!("/api/lanes/{}/diff", segment(&lane_id)), &[("maxBytes", "524288")], None).and_then(checked) {
                    Ok(v) if text(&v,"laneId") != lane_id || text(&v,"headSha").len() != 40 || !text(&v,"headSha").bytes().all(|b| b.is_ascii_hexdigit()) => {
                        errors.push("Branch review returned an invalid lane or HEAD identity.".into());
                    }
                    Ok(v) => {
                        let document = crate::diff::parse(&text(&v, "diff"));
                        read.files = document.files.iter().map(|f| json!({"path":f.path,"status":f.status,"additions":f.additions,"deletions":f.deletions})).collect();
                        read.diff = v;
                    }
                    Err(e) => errors.push(format!("Branch review: {}", e.message)),
                }

            }
            if !errors.is_empty() { read.error = Some(errors.join("\n")); }
            read
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation
                    || this
                        .packet
                        .reads
                        .get(&row.id)
                        .is_none_or(|r| r.request != request)
                    || !this
                        .rows
                        .iter()
                        .any(|r| r.id == row.id && identity(r) == key)
                {
                    return;
                }
                this.packet.reads.insert(row.id, result);
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn packet_focus_editor(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(editor) = &self.packet.editor {
            editor.input.read(cx).focus.focus(window);
        }
    }
    pub(super) fn packet_act(&mut self, command: Command, cx: &mut Context<Self>) {
        match command {
            Command::Read(row) => self.packet_read(row, true, cx),
            Command::Tab(id, tab) => {
                self.packet.tabs.insert(id, tab);
                self.packet.editor = None;
            }
            Command::More(id) => {
                if !self.packet.all_files.remove(&id) {
                    self.packet.all_files.insert(id);
                }
            }
            Command::Brief(id) => {
                if !self.packet.briefs.remove(&id) {
                    self.packet.briefs.insert(id);
                }
            }
            Command::Cancel => self.packet.editor = None,
            Command::Edit(row, field) => {
                if self.pending || !matches!(field, "summary" | "branchTarget") {
                    return;
                }
                let value = text(&row.data, field);
                let input = cx.new(|cx| {
                    let mut input = Composer::new(cx);
                    input.inline = field == "branchTarget";
                    input.newline_on_enter = !input.inline;
                    input.placeholder = format!("Edit {field}");
                    input.set_text(&value, cx);
                    input
                });
                let submit_row = row.clone();
                let submit =
                    cx.subscribe(&input, move |this, _, _: &crate::composer::Submit, cx| {
                        this.packet_act(Command::Save(submit_row.clone()), cx)
                    });
                self.packet.editor = Some(Editor {
                    id: row.id,
                    field,
                    input,
                    _submit: submit,
                });
            }
            Command::Save(row) => {
                let Some(editor) = &self.packet.editor else {
                    return;
                };
                if editor.id != row.id || self.pending {
                    return;
                }
                let content = editor.input.read(cx).text.clone();
                let field = editor.field;
                if content.trim().is_empty() {
                    self.notice = "Enter a value before saving.".into();
                    return;
                }
                if field == "branchTarget" && row.data["queueState"] != "draft" {
                    return;
                }
                let updates = if field == "branchTarget" {
                    json!({"branchTarget":content.trim(),"blockedReason": branch_reason(&row.data)})
                } else {
                    json!({"summary": content})
                };
                self.packet_patch(&row.id, updates, cx);
            }
            Command::Patch(row, updates) => self.packet_patch(&row.id, updates, cx),
            Command::Diff(row) => cx.emit(ActivityEvent::Diff(row.id)),
        }
        self.changed(cx);
    }
    fn packet_patch(&mut self, id: &str, updates: Value, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.notice_error = false;
        self.packet.action = Some(id.into());
        self.notice = "Saving packet…".into();
        let client = self.client.clone();
        let generation = self.generation;
        let id = id.to_string();
        let body = json!({"packetId":id,"updates":updates});
        let task = cx.background_executor().spawn(async move {
            client
                .activity_request("PATCH", "/api/orchestrator/state", &[], Some(&body))
                .and_then(checked)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                this.notice_error = result.is_err();
                this.notice = match &result {
                    Ok(_) => "Packet updated.".into(),
                    Err(e) => e.message.clone(),
                };
                if result.is_ok() {
                    this.packet.editor = None;
                    this.packet.reads.remove(&id);
                }
                if generation == this.generation {
                    this.load(cx);
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
}

pub(super) fn branch_reason(packet: &Value) -> Value {
    let reason = text(packet, "blockedReason");
    if reason.starts_with("Select a branch") || reason.starts_with("Branch target") {
        Value::Null
    } else {
        packet["blockedReason"].clone()
    }
}

/// UTC civil date from Unix days; no locale or process launch in rendering.
pub(super) fn iso_now() -> String {
    let seconds = crate::clock::now();
    let z = seconds as i64 / 86400 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}

#[cfg(test)]
impl ActivityPane {
    pub(in super::super) fn packet_evidence(&self, id: &str) -> Value {
        match self.packet.reads.get(id) {
            Some(r) => {
                json!({"loading":r.loading,"spec":r.spec,"files":r.files.len(),"error":r.error,"request":r.request})
            }
            None => Value::Null,
        }
    }
}
