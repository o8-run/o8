//! Original Apache-2.0 GPUI PR surface; all writes remain server-authorized.
use crate::{client::Client, composer::Composer};
use gpui::{AppContext, Context, Entity, FocusHandle, Window};
use serde_json::{Value, json};
use std::{cell::Cell, collections::HashMap, rc::Rc, time::Instant};

pub fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn array(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
#[derive(Clone, Default)]
pub struct Delivery {
    pub attempt: u64,
    pub uncertain: bool,
    pub partial_close: bool,
    pub busy: bool,
    pub notice: String,
}
#[derive(Default)]
struct Deliveries(HashMap<String, Delivery>);
impl gpui::Global for Deliveries {}

fn delivery_key(repo: &str, number: u64) -> String {
    format!("{}#{number}", repo.to_lowercase())
}

fn posts_draft(action: &str) -> bool {
    [
        "comment",
        "close-with-comment",
        "review-comment",
        "approve",
        "request-changes",
    ]
    .contains(&action)
}
#[derive(Clone)]
pub struct Confirmation {
    pub repo: String,
    pub number: u64,
    pub head: String,
    pub action: String,
    pub method: String,
    pub body: String,
    pub draft: Option<String>,
}
pub struct PullRequests {
    client: Client,
    workspace: String,
    pub focus: FocusHandle,
    pub search: Entity<Composer>,
    pub editor: Entity<Composer>,
    pub page: Value,
    pub rows: Vec<Value>,
    pub detail: Value,
    pub selected: Option<u64>,
    pub state: String,
    pub sort: String,
    pub scope: String,
    pub layout: String,
    pub filters: HashMap<&'static str, String>,
    pub viewer: String,
    pub tab: String,
    pub loading: bool,
    pub detail_loading: bool,
    pub error: String,
    pub detail_error: String,
    pub confirmation: Option<Confirmation>,
    pub review_head: String,
    pub packet: Option<String>,
    pub preview: Value,
    pub governance_error: String,
    pub revision: u64,
    pub painted: Rc<Cell<u64>>,
    pub painted_at: Rc<Cell<Option<Instant>>>,
    pub ready_painted_at: Rc<Cell<Option<Instant>>>,
    list_epoch: u64,
    detail_epoch: u64,
    _subscriptions: Vec<gpui::Subscription>,
}
impl PullRequests {
    pub fn new(
        client: Client,
        workspace: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.default_global::<Deliveries>();
        let search = cx.new(Composer::new);
        let editor = cx.new(Composer::new);
        let focus = cx.focus_handle();
        focus.focus(window);
        let subscriptions = vec![
            cx.observe(&search, |s, _, cx| {
                s.changed(cx);
            }),
            cx.observe(&editor, |s, _, cx| {
                s.changed(cx);
            }),
            cx.observe_global::<Deliveries>(|s, cx| s.changed(cx)),
        ];
        let mut s = Self {
            client,
            workspace,
            focus,
            search,
            editor,
            page: Value::Null,
            rows: vec![],
            detail: Value::Null,
            selected: None,
            state: "open".into(),
            sort: "updated".into(),
            scope: "all".into(),
            layout: "authors".into(),
            filters: HashMap::new(),
            viewer: String::new(),
            tab: "summary".into(),
            loading: false,
            detail_loading: false,
            error: String::new(),
            detail_error: String::new(),
            confirmation: None,
            review_head: String::new(),
            packet: None,
            preview: Value::Null,
            governance_error: String::new(),
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            painted_at: Rc::new(Cell::new(None)),
            ready_painted_at: Rc::new(Cell::new(None)),
            list_epoch: 0,
            detail_epoch: 0,
            _subscriptions: subscriptions,
        };
        s.load(false, cx);
        s
    }
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        cx.notify();
    }
    pub fn load(&mut self, more: bool, cx: &mut Context<Self>) {
        let page = if more {
            self.page["nextPage"].as_u64().unwrap_or(1)
        } else {
            1
        };
        self.list_epoch += 1;
        let epoch = self.list_epoch;
        self.loading = true;
        self.error.clear();
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let state = if self.state == "merged" {
            "closed".into()
        } else {
            self.state.clone()
        };
        let sort = self.sort.clone();
        let task = cx.background_executor().spawn(async move {
            let result = client.get::<Value>(
                "/api/panel/prs",
                &[
                    ("repoPath", &workspace),
                    ("view", "list"),
                    ("state", &state),
                    ("sort", &sort),
                    ("page", &page.to_string()),
                ],
            );
            let viewer = client.get::<Value>("/api/panel/github-status", &[]).ok();
            (result, viewer)
        });
        cx.spawn(async move |this, cx| {
            let (result, viewer) = task.await;
            let _ = this.update(cx, |s, cx| {
                if s.list_epoch != epoch {
                    return;
                }
                s.loading = false;
                if let Some(v) = viewer.filter(|v| v["authenticated"] == true) {
                    s.viewer = string(&v, "username").to_lowercase();
                }
                match result {
                    Ok(page) if page["prs"].is_array() && page["error"].is_null() => {
                        if !s.page.is_null() && page["repo"] != s.page["repo"] {
                            s.rows.clear();
                            s.selected = None;
                            s.detail = Value::Null;
                            s.confirmation = None;
                            s.detail_epoch += 1;
                            s.detail_loading = false;
                            s.detail_error.clear();
                        }
                        if !more {
                            s.rows.clear();
                        }
                        for row in array(&page, "prs") {
                            if !s.rows.iter().any(|r| r["number"] == row["number"]) {
                                s.rows.push(row);
                            }
                        }
                        s.page = page;
                    }
                    Ok(_) => s.error = "Pull requests could not be loaded. Try again.".into(),
                    Err(error) => s.error = error,
                }
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub fn select(&mut self, number: u64, cx: &mut Context<Self>) {
        if self.selected != Some(number) {
            self.detail = Value::Null;
            self.review_head.clear();
            self.tab = "summary".into();
            self.editor.update(cx, |e, cx| e.clear(cx));
        }
        self.selected = Some(number);
        self.confirmation = None;
        self.detail_loading = true;
        self.detail_error.clear();
        self.preview = Value::Null;
        self.packet = None;
        self.governance_error.clear();
        self.detail_epoch += 1;
        let epoch = self.detail_epoch;
        let client = self.client.clone();
        let repo = string(&self.page, "repo").to_owned();
        let workspace = self.workspace.clone();
        let task = cx.background_executor().spawn(async move {
            let detail = client.get::<Value>(&format!("/api/panel/prs/{number}"), &[("repo", &repo)]);
            let governance = client.get::<Value>("/api/orchestrator/state", &[]).and_then(|state| {
                if !state["mission"]["packets"].is_array() { return Err("Packet state is unavailable. Refresh before merging.".into()); }
                let branch = detail.as_ref().ok().map(|d| string(&d["pr"], "headRefName")).unwrap_or("");
                let packets: Vec<_> = array(&state["mission"], "packets").into_iter().filter(|p| std::fs::canonicalize(string(p, "workspaceTargetPath")).ok().zip(std::fs::canonicalize(&workspace).ok()).is_some_and(|(a,b)| a == b) && string(p, "branchTarget") == branch && p["status"] != "archived").collect();
                if packets.len() > 1 { return Err("Multiple packets match this branch. Inspect the packet before merging.".into()); }
                let packet = packets.first().map(|p| string(p, "id").to_owned());
                let preview = match &packet { Some(id) => client.pr_preview(id)?, None => Value::Null };
                Ok((packet, preview))
            }); (detail, governance)
        });
        cx.spawn(async move |this, cx| {
            let (result, governance) = task.await;
            let _ = this.update(cx, |s, cx| {
                if s.detail_epoch != epoch || s.selected != Some(number) {
                    return;
                }
                s.detail_loading = false;
                match result {
                    Ok(v)
                        if v["pr"]["number"].as_u64() == Some(number)
                            && v["pr"]["resolvedRepo"] == s.page["repo"] =>
                    {
                        s.detail = v["pr"].clone();
                        if s.review_head.is_empty() {
                            s.review_head = string(&s.detail, "headSha").into();
                        }
                    }
                    Ok(_) => {
                        s.detail_error =
                            "Pull request identity changed. Refresh before continuing.".into()
                    }
                    Err(e) => s.detail_error = e,
                }
                match governance {
                    Ok((packet, preview)) => {
                        s.packet = packet;
                        s.preview = preview;
                    }
                    Err(e) => s.governance_error = e,
                }
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub fn visible(&self, cx: &gpui::App) -> Vec<Value> {
        let query = self.search.read(cx).text.to_lowercase();
        self.rows
            .iter()
            .filter(|p| {
                let mine = string(p, "author").to_lowercase() == self.viewer;
                if self.state != "all" && string(p, "state") != self.state {
                    return false;
                }
                if (self.scope == "authored" && !mine)
                    || (self.scope == "others" && mine)
                    || (self.scope == "reviewing"
                        && !array(p, "requestedReviewers")
                            .iter()
                            .any(|v| v.as_str().unwrap_or("").to_lowercase() == self.viewer))
                {
                    return false;
                }
                for (key, value) in &self.filters {
                    if value.is_empty() {
                        continue;
                    }
                    if match *key {
                        "label" => !array(p, "labels").iter().any(|v| v.as_str() == Some(value)),
                        "draft" => p["draft"].as_bool().unwrap_or(false) != (value == "draft"),
                        "checks" => p["checks"].as_str().unwrap_or("unknown") != value,
                        _ => string(p, key) != value,
                    } {
                        return false;
                    }
                }
                let text = format!(
                    "{} {} {} {} {}",
                    p["number"],
                    string(p, "title"),
                    string(p, "author"),
                    string(p, "headRefName"),
                    p["labels"]
                )
                .to_lowercase();
                regex::Regex::new(r#"[^\s"]+|"[^"]*""#)
                    .unwrap()
                    .find_iter(&query)
                    .all(|term| {
                        let token = term.as_str().replace('"', "");
                        if let Some(label) = token.strip_prefix("label:") {
                            array(p, "labels")
                                .iter()
                                .any(|v| v.as_str().unwrap_or("").to_lowercase() == label)
                        } else if let Some(author) = token.strip_prefix("author:") {
                            string(p, "author").to_lowercase()
                                == if author == "me" { &self.viewer } else { author }
                        } else {
                            text.contains(&token)
                        }
                    })
            })
            .cloned()
            .collect()
    }
    pub fn delivery(&self, cx: &gpui::App) -> Delivery {
        self.selected
            .and_then(|n| cx.global::<Deliveries>().0.get(&self.delivery_key(n)))
            .cloned()
            .unwrap_or_default()
    }
    pub fn delivery_key(&self, number: u64) -> String {
        let repo = self.detail["resolvedRepo"]
            .as_str()
            .unwrap_or_else(|| string(&self.page, "repo"));
        delivery_key(repo, number)
    }
    pub fn acknowledge(&mut self, number: u64, key: &str, attempt: u64, cx: &mut Context<Self>) {
        if self.selected != Some(number) || self.delivery_key(number) != key {
            return;
        }
        let Some(d) = cx.global_mut::<Deliveries>().0.get_mut(key) else {
            return;
        };
        if d.attempt != attempt || d.busy || !d.uncertain {
            return;
        }
        *d = Delivery {
            attempt,
            ..Default::default()
        };
        self.select(number, cx);
    }
    pub fn can(&self, action: &str, method: &str, cx: &gpui::App) -> bool {
        let d = self.delivery(cx);
        let head = string(&self.detail, "headSha");
        if self.detail.is_null()
            || self.detail["resolvedRepo"] != self.page["repo"]
            || self.detail_loading
            || !self.detail_error.is_empty()
            || d.busy
            || d.uncertain
            || (d.partial_close && action != "close")
        {
            return false;
        }
        let open = string(&self.detail, "state").eq_ignore_ascii_case("open")
            && self.detail["mergedAt"].is_null();
        let needs_body = [
            "comment",
            "close-with-comment",
            "request-changes",
            "review-comment",
        ]
        .contains(&action);
        if needs_body && self.editor.read(cx).text.trim().is_empty() {
            return false;
        }
        if ["approve", "request-changes", "review-comment"].contains(&action)
            && (head.is_empty() || head != self.review_head)
        {
            return false;
        }
        if [
            "merge",
            "draft",
            "ready",
            "enable-auto-merge",
            "disable-auto-merge",
            "close",
            "close-with-comment",
        ]
        .contains(&action)
            && (!open || head.is_empty())
        {
            return false;
        }
        if ["merge", "enable-auto-merge"].contains(&action) {
            if self.detail["draft"] == true
                || (!self.detail["allowedMergeMethods"].is_null()
                    && !array(&self.detail, "allowedMergeMethods").contains(&json!(method)))
            {
                return false;
            }
            if !self.governance_error.is_empty() {
                return false;
            }
            // The PR protocol cannot atomically enforce packet gates, and the
            // packet protocol cannot preserve this PR's method/base identity.
            if self.packet.is_some() {
                return false;
            }
        }
        true
    }
    pub fn prepare(&mut self, action: &str, method: &str, cx: &mut Context<Self>) {
        if !self.can(action, method, cx) {
            return;
        }
        let draft = posts_draft(action).then(|| self.editor.read(cx).text.clone());
        self.confirmation = Some(Confirmation {
            repo: string(&self.detail, "resolvedRepo").into(),
            number: self.selected.unwrap(),
            head: string(&self.detail, "headSha").into(),
            action: action.into(),
            method: method.into(),
            body: draft.as_deref().unwrap_or("").trim().into(),
            draft,
        });
        self.changed(cx);
    }
    pub fn confirm(&mut self, cx: &mut Context<Self>) {
        let Some(c) = self.confirmation.clone() else {
            return;
        };
        if self.selected != Some(c.number)
            || c.repo != string(&self.detail, "resolvedRepo")
            || c.head != string(&self.detail, "headSha")
            || !self.can(&c.action, &c.method, cx)
        {
            return;
        }
        self.confirmation = None;
        let d = cx
            .global_mut::<Deliveries>()
            .0
            .entry(delivery_key(&c.repo, c.number))
            .or_default();
        d.attempt = d.attempt.wrapping_add(1);
        d.busy = true;
        let attempt = d.attempt;
        let client = self.client.clone();
        let sent = c.clone();
        let task = cx.background_executor().spawn(async move {
            // Match the desktop PR control: merge this repository's PR using
            // the chosen method and expected head, never a different packet/base.
            client.pr_post(&format!("/api/panel/prs/{}", sent.number), &json!({"repo":sent.repo,"action":sent.action,"comment":sent.body,"commitSha":sent.head,"mergeMethod":sent.method}))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            // Resolve the app-wide hold even if its originating surface closed.
            let posted = cx.update(|cx| {
                let d = cx.global_mut::<Deliveries>().0.entry(delivery_key(&c.repo, c.number)).or_default();
                if d.attempt != attempt { return false; }
                d.busy = false;
                let confirmed = match result {
                    Ok(v) if c.action == "close-with-comment" && v["commentPosted"] == true && v["ok"] != true => {
                        d.partial_close = true;
                        d.notice = "Comment posted. Closing could not be confirmed. Retry close without posting again.".into();
                        true
                    }
                    Ok(v) if v["ok"] == true && v["outcomeUnknown"] != true && v["inProgress"] != true => {
                        *d = Delivery { attempt, notice: format!("{} completed.", c.action), ..Default::default() };
                        true
                    }
                    _ => {
                        d.uncertain = true;
                        d.notice = "Could not confirm delivery. Check this pull request on GitHub before another attempt.".into();
                        false
                    }
                };
                confirmed && c.draft.is_some()
            }).unwrap_or(false);
            let _ = this.update(cx, |s, cx| {
                if s.selected == Some(c.number) && string(&s.detail,"resolvedRepo") == c.repo {
                    if posted && c.draft.as_deref() == Some(s.editor.read(cx).text.as_str()) { s.editor.update(cx, |e,cx| e.clear(cx)); }
                    s.select(c.number, cx);
                }
                s.load(false, cx); s.changed(cx);
            });
        }).detach();
        self.changed(cx);
    }
}
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
#[path = "view.rs"]
mod view;
