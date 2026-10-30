//! Original Apache-2.0 issue surface, using the desktop's server contracts.
use crate::{
    client::{Client, Session, same_workspace},
    composer::{Composer, Submit},
    ui::Surface,
};
use gpui::{App, Context, Entity, FocusHandle, Window, prelude::*};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeSet, HashMap},
    rc::Rc,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub labels: Vec<Value>,
    #[serde(default)]
    pub author: Value,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub url: String,
}
#[derive(Clone)]
pub struct LinkedIssue {
    pub repo: String,
    pub issue: Issue,
}
impl LinkedIssue {
    pub fn context(&self) -> String {
        let body = self.issue.body.as_deref().unwrap_or("").trim();
        let mut compact = String::new();
        let mut units = 0;
        for ch in body.chars() {
            if units + ch.len_utf16() > 1400 {
                break;
            }
            compact.push(ch);
            units += ch.len_utf16();
        }
        if compact.len() < body.len() {
            compact.push('…');
        }
        let title = format!(
            "Linked GitHub issue #{} in {}: {}.",
            self.issue.number, self.repo, self.issue.title
        );
        if compact.is_empty() {
            title
        } else {
            format!("{title}\n\nIssue context:\n{compact}")
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    name: String,
    local_path: String,
    remote_url: Option<String>,
    #[serde(default)]
    readiness: Value,
    #[serde(default)]
    exists: Option<bool>,
}
impl Repository {
    fn slug(&self) -> Option<String> {
        let remote = self.remote_url.as_deref()?.trim_end_matches(".git");
        let remote = remote
            .strip_prefix("git@github.com:")
            .or_else(|| remote.strip_prefix("https://github.com/"))?;
        let parts: Vec<_> = remote.split('/').collect();
        (parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            }))
        .then(|| remote.to_owned())
    }
    fn missing(&self) -> bool {
        self.exists == Some(false) || self.readiness["state"] == "missing"
    }
}
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    List,
    Detail,
    Create,
    Worker,
}
#[derive(Clone, Copy)]
enum Action {
    List,
    Detail(u64),
    Enhance,
    Create,
}
#[derive(Debug)]
pub struct IssueError {
    pub message: String,
    pub retry_after: u64,
    pub creation_refused: bool,
}
struct Draft {
    title: Entity<Composer>,
    body: Entity<Composer>,
    label: Entity<Composer>,
    labels: Vec<String>,
    preview: bool,
    enhanced: bool,
    created: Option<u64>,
    pending_creation: Option<Value>,
}
impl From<String> for IssueError {
    fn from(message: String) -> Self {
        Self {
            message,
            retry_after: 0,
            creation_refused: false,
        }
    }
}

pub struct Issues {
    client: Client,
    repos: Vec<Repository>,
    selected: usize,
    preferred: Option<String>,
    sessions: Vec<Session>,
    worker: Option<Entity<Surface>>,
    issues: Vec<Issue>,
    detail: Option<Issue>,
    detail_number: Option<u64>,
    linked: Option<LinkedIssue>,
    mode: Mode,
    title: Entity<Composer>,
    body: Entity<Composer>,
    label: Entity<Composer>,
    drafts: HashMap<String, Draft>,
    pending_creation: Option<Value>,
    /// An issue to show once its repository's list has loaded.
    opening: Option<(String, u64)>,
    search: Entity<Composer>,
    labels: Vec<String>,
    preview: bool,
    enhanced: bool,
    created: Option<u64>,
    busy: bool,
    activity: &'static str,
    error: String,
    retry_at: Option<Instant>,
    generation: u64,
    focus: FocusHandle,
    subscriptions: Vec<gpui::Subscription>,
    revision: u64,
    painted: Rc<Cell<u64>>,
    painted_controls: Rc<RefCell<BTreeSet<String>>>,
}
impl Issues {
    #[cfg(test)]
    pub(crate) fn worker_state(&self, cx: &App) -> Value {
        self.worker
            .as_ref()
            .map(|w| w.read(cx).shell_issue_state(cx))
            .unwrap_or(Value::Null)
    }
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Value {
        json!({"repo": self.slug(), "issues": self.issues.iter().map(|i| i.number).collect::<Vec<_>>(), "busy": self.busy, "error": self.error, "controls": *self.painted_controls.borrow(), "detail": self.detail_number, "opening": self.opening.as_ref().map(|(_, number)| number)})
    }
    pub fn new(
        client: Client,
        preferred: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = cx.new(Composer::new);
        let body = cx.new(Composer::new);
        let label = cx.new(Composer::new);
        let search = cx.new(Composer::new);
        let mut this = Self {
            client,
            repos: vec![],
            selected: 0,
            preferred,
            sessions: vec![],
            worker: None,
            issues: vec![],
            detail: None,
            detail_number: None,
            linked: None,
            mode: Mode::List,
            title,
            body,
            label: label.clone(),
            drafts: HashMap::new(),
            pending_creation: None,
            opening: None,
            search: search.clone(),
            labels: vec![],
            preview: false,
            enhanced: false,
            created: None,
            busy: false,
            activity: "Loading registered repositories…",
            error: String::new(),
            retry_at: None,
            generation: 0,
            focus: cx.focus_handle(),
            subscriptions: vec![],
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            painted_controls: Rc::new(RefCell::new(BTreeSet::new())),
        };
        this.watch_label(cx);
        this.subscriptions
            .push(cx.observe(&search, |s, _, cx| s.changed(cx)));
        this.focus.focus(window);
        this.load_repos(cx);
        this
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        cx.notify();
    }
    fn watch_label(&mut self, cx: &mut Context<Self>) {
        self.subscriptions
            .push(cx.subscribe(&self.label, |s, editor, _: &Submit, cx| {
                if s.label.entity_id() == editor.entity_id() {
                    s.add_label(cx);
                }
            }));
    }
    pub fn focus(&self, window: &mut Window, cx: &App) {
        self.focus.focus(window);
        let _ = cx;
    }
    pub fn tick(&self, refresh: bool, cx: &mut Context<Self>) {
        if let Some(worker) = &self.worker {
            worker.update(cx, |s, cx| s.shell_tick(refresh, cx));
        }
    }
    fn slug(&self) -> Option<String> {
        self.repos.get(self.selected)?.slug()
    }
    /// Activity's issue destination: one issue of a registered repository,
    /// shown after that repository's list loads. An unregistered repository's
    /// issue opens on GitHub.
    pub fn open(&mut self, slug: &str, number: u64, cx: &mut Context<Self>) {
        self.opening = Some((slug.to_owned(), number));
        if self.repos.is_empty() && self.busy {
            return;
        }
        let Some(index) = self.repo_index(slug) else {
            self.opening = None;
            cx.open_url(&format!("https://github.com/{slug}/issues/{number}"));
            return;
        };
        if index != self.selected {
            self.select_repo(index, cx);
        } else if !self.busy {
            self.opening = None;
            self.request(Action::Detail(number), cx);
        }
    }
    fn repo_index(&self, slug: &str) -> Option<usize> {
        self.repos
            .iter()
            .position(|r| r.slug().is_some_and(|s| s.eq_ignore_ascii_case(slug)))
    }
    fn load_repos(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.activity = "Loading registered repositories…";
        self.error.clear();
        let client = self.client.clone();
        let generation = self.generation;
        let task = cx.background_executor().spawn(async move {
            let response = client.issue_request("GET", "/api/panel/repos", &[], None)?;
            let repos: Vec<Repository> = serde_json::from_value(response["repos"].clone())
                .map_err(|_| IssueError::from("Invalid repository list".to_owned()))?;
            Ok::<_, IssueError>((repos, client.sessions().unwrap_or_default()))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                match result {
                    Ok((repos, sessions)) => {
                        this.repos = repos.into_iter().filter(|r| r.slug().is_some()).collect();
                        this.sessions = sessions;
                        let opening = this
                            .opening
                            .as_ref()
                            .map(|(slug, number)| (this.repo_index(slug), slug.clone(), *number));
                        if let Some((None, slug, number)) = &opening {
                            this.opening = None;
                            cx.open_url(&format!("https://github.com/{slug}/issues/{number}"));
                        }
                        this.selected = opening
                            .and_then(|(index, _, _)| index)
                            .or_else(|| {
                                let path = this.preferred.as_ref()?;
                                this.repos
                                    .iter()
                                    .position(|r| same_workspace(&r.local_path, path))
                            })
                            .unwrap_or(0);
                        this.request(Action::List, cx);
                    }
                    Err(error) => this.fail(error),
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    fn fail(&mut self, error: IssueError) {
        self.error = error.message;
        self.retry_at = (error.retry_after > 0)
            .then(|| Instant::now() + Duration::from_secs(error.retry_after.min(86400)));
    }
    fn select_repo(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.repos.len() || index == self.selected {
            return;
        }
        if let Some(repo) = self.slug() {
            self.drafts.insert(
                repo,
                Draft {
                    title: self.title.clone(),
                    body: self.body.clone(),
                    label: self.label.clone(),
                    labels: self.labels.clone(),
                    preview: self.preview,
                    enhanced: self.enhanced,
                    created: self.created,
                    pending_creation: self.pending_creation.clone(),
                },
            );
        }
        self.generation += 1;
        self.busy = false;
        self.selected = index;
        let saved = self.drafts.remove(&self.slug().unwrap());
        let fresh = saved.is_none();
        let draft = saved.unwrap_or_else(|| Draft {
            title: cx.new(Composer::new),
            body: cx.new(Composer::new),
            label: cx.new(Composer::new),
            labels: vec![],
            preview: false,
            enhanced: false,
            created: None,
            pending_creation: None,
        });
        self.title = draft.title;
        self.body = draft.body;
        self.label = draft.label;
        self.labels = draft.labels;
        self.preview = draft.preview;
        self.enhanced = draft.enhanced;
        self.created = draft.created;
        self.pending_creation = draft.pending_creation;
        if fresh {
            self.watch_label(cx);
        }
        self.issues.clear();
        self.detail = None;
        self.detail_number = None;
        self.mode = Mode::List;
        self.worker = None;
        self.linked = None;
        self.error.clear();
        self.retry_at = None;
        self.request(Action::List, cx);
    }
    fn request(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.busy || self.retry_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let Some(repo) = self.slug() else {
            self.changed(cx);
            return;
        };
        let title = self.title.read(cx).text.trim().to_owned();
        let body = self.body.read(cx).text.trim().to_owned();
        if matches!(action, Action::Enhance) && title.is_empty() && body.is_empty() {
            return;
        }
        if matches!(action, Action::Create) && title.is_empty() {
            self.error = "Title is required".into();
            self.changed(cx);
            return;
        }
        let mut creation = json!({"repo":repo,"title":title});
        if !body.is_empty() {
            creation["description"] = json!(body);
        }
        if !self.labels.is_empty() {
            creation["labels"] = json!(self.labels);
        }
        if matches!(action, Action::Create) {
            if let Some(pending) = &self.pending_creation {
                let mut original = pending.clone();
                original.as_object_mut().unwrap().remove("clientMutationId");
                if original != creation {
                    self.error = "Creation is unconfirmed. Restore the original draft to retry its saved request, or inspect GitHub before creating another issue.".into();
                    self.changed(cx);
                    return;
                }
                creation = pending.clone();
            } else {
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                creation["clientMutationId"] =
                    json!(format!("next-issue-{nonce:x}-{:x}", std::process::id()));
                self.pending_creation = Some(creation.clone());
            }
        }
        if let Action::Detail(number) = action {
            self.mode = Mode::Detail;
            self.detail_number = Some(number);
        }
        self.busy = true;
        self.activity = match action {
            Action::List => "Loading issues…",
            Action::Detail(_) => "Loading issue…",
            Action::Enhance => "Enhancing issue…",
            Action::Create => "Creating issue…",
        };
        self.error.clear();
        self.retry_at = None;
        let client = self.client.clone();
        let generation = self.generation;
        let task = cx.background_executor().spawn(async move {
            match action {
                Action::List => {
                    client.issue_request("GET", "/api/panel/issues", &[("repo", &repo)], None)
                }
                Action::Detail(number) => client.issue_request(
                    "GET",
                    &format!("/api/panel/issues/{number}"),
                    &[("repo", &repo)],
                    None,
                ),
                Action::Enhance => client.issue_request(
                    "POST",
                    "/api/panel/issues/enhance",
                    &[],
                    Some(json!({"repo":repo,"title":title,"description":body})),
                ),
                Action::Create => {
                    client.issue_request("POST", "/api/panel/issues/create", &[], Some(creation))
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                let result = result.and_then(|value| this.accept(action, value, cx));
                if let Err(error) = result {
                    if matches!(action, Action::Create) && error.creation_refused {
                        this.pending_creation = None;
                    }
                    this.fail(error);
                }
                // An issue opened from Activity follows its repository's list.
                if let Some((slug, number)) = this.opening.take()
                    && this.slug().is_some_and(|s| s.eq_ignore_ascii_case(&slug))
                {
                    this.request(Action::Detail(number), cx);
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    fn accept(
        &mut self,
        action: Action,
        value: Value,
        cx: &mut Context<Self>,
    ) -> Result<(), IssueError> {
        let invalid = || IssueError::from("Unable to read issue response".to_owned());
        if let Some(repo) = value["repo"].as_str() {
            if Some(repo) != self.slug().as_deref() {
                return Err(invalid());
            }
        }
        match action {
            Action::List => {
                let issues = serde_json::from_value::<Vec<Issue>>(value["issues"].clone())
                    .map_err(|_| invalid())?;
                self.issues = issues
                    .into_iter()
                    .filter(|i| i.state.eq_ignore_ascii_case("open"))
                    .collect();
                if let Some(error) = value["error"].as_str() {
                    self.error = format!("{error} · Showing last successful issues.");
                }
            }
            Action::Detail(number) => {
                let issue: Issue =
                    serde_json::from_value(value.get("issue").unwrap_or(&value).clone())
                        .map_err(|_| invalid())?;
                if issue.number != number {
                    return Err(invalid());
                }
                self.detail = Some(issue);
            }
            Action::Enhance => {
                for (key, editor) in [("title", &self.title), ("body", &self.body)] {
                    if let Some(text) = value[key].as_str().filter(|s| !s.is_empty()) {
                        editor.update(cx, |i, cx| i.set_text(text, cx));
                    }
                }
                if let Some(labels) = value["labels"].as_array() {
                    for label in labels.iter().filter_map(Value::as_str) {
                        if !self.labels.iter().any(|l| l == label) {
                            self.labels.push(label.into());
                        }
                    }
                }
                self.enhanced = true;
            }
            Action::Create => {
                if value["ok"] != true {
                    return Err(invalid());
                }
                self.created = Some(
                    value["number"]
                        .as_u64()
                        .filter(|n| *n > 0)
                        .ok_or_else(invalid)?,
                );
                self.pending_creation = None;
            }
        }
        Ok(())
    }
    fn add_label(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let label = self.label.read(cx).text.trim().to_lowercase();
        if !label.is_empty() && !self.labels.contains(&label) {
            self.labels.push(label);
        }
        self.label.update(cx, |i, cx| i.clear(cx));
        self.changed(cx);
    }
    fn link(&mut self, issue: Issue, window: &mut Window, cx: &mut Context<Self>) {
        let Some(repo) = self.slug() else {
            return;
        };
        self.linked = Some(LinkedIssue { repo, issue });
        self.ensure_worker(window, cx);
        if let Some(worker) = &self.worker {
            worker.update(cx, |s, cx| s.shell_link_issue(self.linked.clone(), cx));
        }
        self.changed(cx);
    }
    fn ensure_worker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.worker.is_some() {
            return;
        }
        let Some(repo) = self.repos.get(self.selected).filter(|r| !r.missing()) else {
            return;
        };
        let mut sessions: Vec<_> = self
            .sessions
            .iter()
            .filter(|s| {
                s.repo_path
                    .as_ref()
                    .is_some_and(|path| same_workspace(path, &repo.local_path))
            })
            .cloned()
            .collect();
        sessions
            .retain(|s| !s.id.contains(':') && s.backend.as_ref().is_some_and(|b| !b.is_empty()));
        sessions.sort_by(|a, b| a.id.cmp(&b.id));
        let Some(id) = sessions.first().map(|s| s.id.clone()) else {
            return;
        };
        let client = self.client.in_workspace(&repo.local_path);
        let worker = cx.new(|cx| Surface::shell_new(client, sessions, id, window, cx));
        self.subscriptions
            .push(cx.observe(&worker, |s, worker, cx| {
                if s.worker
                    .as_ref()
                    .is_some_and(|active| active.entity_id() == worker.entity_id())
                {
                    s.linked = worker.read(cx).shell_linked_issue();
                    s.changed(cx);
                }
            }));
        self.worker = Some(worker);
        if self.mode != Mode::Worker {
            self.focus.focus(window);
        }
    }
    fn work(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(issue) = self.detail.clone() else {
            return;
        };
        if self
            .repos
            .get(self.selected)
            .is_none_or(Repository::missing)
        {
            return;
        }
        self.link(issue, window, cx);
        if let Some(worker) = &self.worker {
            self.mode = Mode::Worker;
            if let Err(error) = worker.update(cx, |s, cx| s.shell_issue_task(window, cx)) {
                self.error = error;
            }
        } else {
            self.error = "No workspace worker session is available. Open a worker session before launching work there.".into();
        }
        self.changed(cx);
    }
}
#[path = "issues_view.rs"]
mod view;
