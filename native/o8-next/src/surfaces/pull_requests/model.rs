//! Original Apache-2.0 GPUI PR surface; all writes remain server-authorized.
use crate::{client::Client, composer::Composer};
use gpui::{AppContext, Context, Entity, FocusHandle, Window};
use serde_json::{Value, json};
use std::{cell::Cell, collections::HashMap, rc::Rc, time::Instant};
#[path = "merge_gate.rs"]
mod merge_gate;
use merge_gate::Submission;

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
    pub merge_gate: Option<String>,
}
/// A pull request picked in the shell's list, for the right panel to open.
pub struct OpenPr {
    pub repo: String,
    pub number: u64,
}
impl gpui::EventEmitter<OpenPr> for PullRequests {}

pub struct PullRequests {
    client: Client,
    workspace: String,
    contextual: Option<(String, u64)>,
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
    /// A pull request to select once the first page names its repository.
    pub pending: Option<(String, u64)>,
    /// The open picker or Filters panel, and the filter field showing its choices.
    pub menu: Option<&'static str>,
    pub filter_field: Option<&'static str>,
    /// Set when the shell hosts this list: picks open in the right panel.
    pub hosted: bool,
    /// PrPanel view state: description, composer ("" while closed, else
    /// "comment" or "review") and review choice, open diffs.
    pub description_open: bool,
    pub composer: &'static str,
    /// A copy or other local result, as PrPanelActions' notice line.
    pub notice: String,
    pub review_action: &'static str,
    pub open_files: std::collections::HashSet<String>,
    /// The Timeline tab's activity pages, read when the tab first shows.
    pub timeline: Vec<Value>,
    pub timeline_next: Option<u64>,
    pub timeline_loading: bool,
    pub timeline_error: String,
    pub newest_first: bool,
    timeline_epoch: u64,
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
        let search = cx.new(|cx| {
            let mut search = Composer::new(cx);
            search.placeholder = "Search pull requests, or label:bug".into();
            search
        });
        let editor = cx.new(|cx| {
            let mut editor = Composer::new(cx);
            editor.placeholder = "Leave a comment".into();
            editor
        });
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
            contextual: None,
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
            pending: None,
            menu: None,
            filter_field: None,
            hosted: false,
            description_open: true,
            composer: "",
            notice: String::new(),
            review_action: "review-comment",
            open_files: Default::default(),
            timeline: vec![],
            timeline_next: None,
            timeline_loading: false,
            timeline_error: String::new(),
            newest_first: false,
            timeline_epoch: 0,
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
    /// A contextual panel owns its selected PR independently of the main list.
    pub(crate) fn new_context(
        client: Client,
        workspace: String,
        repo: String,
        number: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut view = Self::new(client, workspace, window, cx);
        view.list_epoch += 1;
        view.loading = false;
        view.page = json!({"repo": repo, "prs": []});
        view.contextual = Some((repo, number));
        view.select(number, cx);
        view
    }
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        cx.notify();
    }
    pub fn load(&mut self, more: bool, cx: &mut Context<Self>) {
        if let Some((repo, number)) = self.contextual.clone() {
            self.page["repo"] = repo.into();
            self.select(number, cx);
            return;
        }
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
                        if let Some((repo, number)) = s.pending.take() {
                            s.open(&repo, number, cx);
                        }
                    }
                    Ok(_) => s.error = "Pull requests could not be loaded. Try again.".into(),
                    Err(error) => s.error = error,
                }
                // Without a list, still show the requested pull request by its
                // own repository, as classic PrPanel opens by repo and number.
                if let Some((repo, number)) = s.pending.take() {
                    s.select_in(number, repo, cx);
                }
                s.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    /// Activity's "Open PR details": select a pull request of this list's
    /// repository, after the first page loads. Another repository's pull
    /// request opens on GitHub, since this list reads one repository. With
    /// no list, it opens by its own repository.
    pub fn open(&mut self, repo: &str, number: u64, cx: &mut Context<Self>) {
        if self.hosted {
            self.selected = string(&self.page, "repo")
                .eq_ignore_ascii_case(repo)
                .then_some(number);
            cx.emit(OpenPr { repo: repo.to_owned(), number });
            self.changed(cx);
        } else if self.page.is_null() && self.loading {
            self.pending = Some((repo.to_owned(), number));
        } else if self.page.is_null() {
            self.select_in(number, repo.to_owned(), cx);
        } else if string(&self.page, "repo").eq_ignore_ascii_case(repo) {
            self.select(number, cx);
        } else {
            cx.open_url(&format!("https://github.com/{repo}/pull/{number}"));
        }
    }
    /// A row click: in the shell the panel opens it; alone the detail shows beside the list.
    pub fn pick(&mut self, number: u64, cx: &mut Context<Self>) {
        if self.hosted {
            let repo = string(&self.page, "repo").to_owned();
            self.open(&repo, number, cx);
        } else {
            self.select(number, cx);
        }
    }
    pub fn select(&mut self, number: u64, cx: &mut Context<Self>) {
        let repo = string(&self.page, "repo").to_owned();
        self.select_in(number, repo, cx);
    }
    fn select_in(&mut self, number: u64, repo: String, cx: &mut Context<Self>) {
        // A refresh of the same PR refetches its activity too: in place when
        // Timeline shows, otherwise the next time it opens.
        // A request still running is superseded, so it can't land stale.
        if self.selected == Some(number) {
            if self.tab == "timeline" {
                self.load_timeline(false, cx);
            } else {
                self.timeline.clear();
                self.timeline_next = None;
                self.timeline_loading = false;
                self.timeline_epoch += 1;
            }
        }
        if self.selected != Some(number) {
            self.detail = Value::Null;
            self.review_head.clear();
            self.tab = "summary".into();
            self.timeline.clear();
            self.timeline_next = None;
            self.timeline_error.clear();
            self.timeline_epoch += 1;
            self.open_files.clear();
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
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(&format!("/api/panel/prs/{number}"), &[("repo", &repo)])
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let governance = result
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|value| merge_gate::governance(&value["pr"]));
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
    /// usePrTimeline: one page of activity at a time, oldest page first.
    pub fn load_timeline(&mut self, more: bool, cx: &mut Context<Self>) {
        let Some(number) = self.selected else {
            return;
        };
        let page = if more { self.timeline_next.unwrap_or(1) } else { 1 };
        self.timeline_epoch += 1;
        let epoch = self.timeline_epoch;
        self.timeline_loading = true;
        self.timeline_error.clear();
        let client = self.client.clone();
        let repo = string(&self.page, "repo").to_owned();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                &format!("/api/panel/prs/{number}/timeline"),
                &[("repo", &repo), ("page", &page.to_string())],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                if s.timeline_epoch != epoch {
                    return;
                }
                s.timeline_loading = false;
                match result {
                    Ok(v) if v["events"].is_array() => {
                        if !more {
                            s.timeline.clear();
                        }
                        s.timeline.extend(array(&v, "events"));
                        s.timeline_next = v["nextPage"].as_u64();
                    }
                    Ok(v) => {
                        s.timeline_error = v["error"]
                            .as_str()
                            .unwrap_or("Activity could not be loaded.")
                            .to_owned()
                    }
                    Err(e) => s.timeline_error = e,
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
            if merge_gate::snapshot(&self.detail).is_err()
                || self.detail["mergeGate"]["allowed"] != true
            {
                return false;
            }
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
            merge_gate: ["merge", "enable-auto-merge"]
                .contains(&action)
                .then(|| merge_gate::snapshot(&self.detail).unwrap().to_owned()),
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
        let task = cx
            .background_executor()
            .spawn(async move { merge_gate::submit(&client, &sent) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            // Resolve the app-wide hold even if its originating surface closed.
            let posted = cx.update(|cx| {
                let d = cx.global_mut::<Deliveries>().0.entry(delivery_key(&c.repo, c.number)).or_default();
                if d.attempt != attempt { return false; }
                d.busy = false;
                let confirmed = match result {
                    Submission::Refused(notice) => {
                        *d = Delivery { attempt, notice, ..Default::default() };
                        false
                    }
                    Submission::Sent(Ok(v)) if v["mergeRefused"] == true => {
                        *d = Delivery { attempt, notice: string(&v,"error").to_owned(), ..Default::default() };
                        false
                    }
                    Submission::Sent(Ok(v)) if c.action == "close-with-comment" && v["commentPosted"] == true && v["ok"] != true => {
                        d.partial_close = true;
                        d.notice = "Comment posted. Closing could not be confirmed. Retry close without posting again.".into();
                        true
                    }
                    Submission::Sent(Ok(v)) if v["ok"] == true && v["outcomeUnknown"] != true && v["inProgress"] != true => {
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
