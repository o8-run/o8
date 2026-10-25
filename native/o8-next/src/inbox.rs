//! Native Inbox, backed exclusively by the desktop's existing routes.
use crate::client::Client;
use gpui::{Context, EventEmitter, FocusHandle, Window};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

pub const VIEWS: [(&str, &str); 5] = [
    ("replies", "Needs reply"),
    ("contributions", "Contributions"),
    ("approvals", "Approvals"),
    ("agents", "Agent issues"),
    ("history", "History"),
];
fn text(value: &Value, field: &str) -> String {
    value[field].as_str().unwrap_or("").to_owned()
}
fn active(item: &Value) -> bool {
    matches!(
        item["status"].as_str(),
        Some("pending" | "healing" | "human_required" | "escalated")
    )
}
fn unsettled(item: &Value) -> bool {
    matches!(
        item["resolution"]["continuationStatus"].as_str(),
        Some("pending" | "outcome_unknown")
    )
}
#[derive(Clone, Debug)]
pub struct Card {
    pub id: String,
    pub status: String,
    pub source: String,
    pub title: String,
    pub detail: String,
    pub metadata: String,
    pub session: String,
    pub url: String,
    pub approval: bool,
    pub unsettled: bool,
    pub risk: String,
}
impl Card {
    fn incident(item: &Value) -> Self {
        let mut card = Self::base(item);
        card.source = text(item, "kind");
        card.session = text(item, "sessionKey");
        card.title = text(&item["payload"], "title");
        if card.title.is_empty() {
            card.title = text(item, "packetTitle");
        }
        if card.title.is_empty() {
            card.title = label(&card.source);
        }
        card.detail = text(item, "errorExcerpt");
        if card.detail.is_empty() {
            card.detail = text(&item["payload"], "body");
        }
        card.metadata = [
            text(item, "packetReferenceLabel"),
            text(item, "packetTitle"),
            text(item, "repoPath"),
            text(&item["payload"], "verificationKind"),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        if item["repeatCount"].as_u64().unwrap_or(1) > 1 {
            card.metadata
                .push_str(&format!(" · x{}", item["repeatCount"]));
        }
        if card.source == "outside_human_waiting" {
            if let Some(title) = item["payload"]["threadTitle"].as_str() {
                card.title = title.into();
            }
            card.url = text(&item["payload"], "url");
            card.metadata = format!(
                "{} · {} #{} · {}",
                text(&item["payload"], "threadRepo"),
                if item["payload"]["threadKind"] == "pr" {
                    "PR"
                } else {
                    "Issue"
                },
                item["payload"]["threadNumber"],
                text(&item["payload"], "waitingLogin")
            );
        }
        card
    }
    fn contribution(item: &Value) -> Self {
        let mut card = Self::base(item);
        card.source = text(item, "repo");
        card.title = text(item, "title");
        card.url = text(item, "url");
        let kind = text(item, "kind");
        card.status = match kind.as_str() {
            "reply" => "waiting",
            "claim" => "claimed",
            _ => "open",
        }
        .into();
        card.detail = if item["assignees"].as_array().is_some_and(|a| !a.is_empty()) {
            item["assignees"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            text(item, "author")
        };
        if matches!(
            item["authorAssociation"].as_str(),
            Some("FIRST_TIMER" | "FIRST_TIME_CONTRIBUTOR")
        ) {
            card.detail.push_str(" · First-time contributor");
        }
        card.metadata = format!(
            "{} · {} #{}",
            card.source,
            if kind == "pull_request" || item["threadKind"] == "pr" {
                "PR"
            } else if kind == "claim" {
                "Claim"
            } else {
                "Issue"
            },
            item["number"]
        );
        if let Some(since) = item["waitingSince"].as_str() {
            card.metadata.push_str(&format!(" · Waiting since {since}"));
        }
        card
    }
    fn approval(item: &Value) -> Self {
        let mut card = Self::base(item);
        card.approval = true;
        card.unsettled = unsettled(item);
        card.source = text(item, "source");
        card.title = text(item, "title");
        card.detail = text(item, "description");
        if card.detail.is_empty() {
            card.detail = text(item, "summary");
        }
        card.risk = text(item, "risk");
        card.session = text(item, "sessionKey");
        card.metadata = [
            text(item, "agent"),
            text(item, "runtime"),
            text(item, "toolName"),
            text(&item["metadata"], "RepoPath"),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        if let Some(command) = item["command"].as_str() {
            card.detail.push_str(&format!("\n$ {command}"));
        }
        card
    }
    fn base(item: &Value) -> Self {
        Self {
            id: text(item, "id"),
            status: text(item, "status"),
            source: String::new(),
            title: String::new(),
            detail: String::new(),
            metadata: String::new(),
            session: String::new(),
            url: String::new(),
            approval: false,
            unsettled: false,
            risk: String::new(),
        }
    }
}
pub fn label(value: &str) -> String {
    let mut label = value.replace('_', " ");
    if let Some(first) = label.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    label
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feed {
    contributions: Vec<Value>,
    replies: Vec<Value>,
    sources: Vec<Value>,
    truncated: bool,
    replies_truncated: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxResponse {
    items: Vec<Value>,
    maintainer: Option<Feed>,
    maintainer_error: Option<String>,
}
#[derive(Deserialize)]
struct ApprovalsResponse {
    approvals: Vec<Value>,
}

pub struct OpenSession(pub String);
impl EventEmitter<OpenSession> for Inbox {}
pub struct Inbox {
    client: Client,
    workspace: String,
    pub(crate) focus: FocusHandle,
    pub(crate) lane: usize,
    pub(crate) selected: usize,
    pub(crate) all: bool,
    items: Vec<Value>,
    feed: Feed,
    approvals: Vec<Value>,
    pub(crate) cards: [Vec<Card>; 5],
    pub(crate) loading: bool,
    pub(crate) loaded: bool,
    pub(crate) errors: [Option<String>; 3],
    pub(crate) busy: Option<String>,
    pub(crate) action_focus: HashMap<String, [FocusHandle; 2]>,
    uncertain: HashSet<String>,
    pub(crate) notice: String,
    pub(crate) scroll: gpui::ScrollHandle,
    last_refresh: Instant,
    revision: u64,
}
impl Inbox {
    pub fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        crate::keymap::install(cx);
        let all = workspace.is_empty();
        let mut inbox = Self {
            client,
            workspace,
            focus: cx.focus_handle(),
            lane: 0,
            selected: 0,
            all,
            items: vec![],
            feed: Feed::default(),
            approvals: vec![],
            cards: Default::default(),
            loading: false,
            loaded: false,
            errors: Default::default(),
            busy: None,
            action_focus: HashMap::new(),
            uncertain: HashSet::new(),
            notice: String::new(),
            scroll: gpui::ScrollHandle::new(),
            last_refresh: Instant::now(),
            revision: 0,
        };
        inbox.load(cx);
        inbox
    }
    pub fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    pub fn tick(&mut self, cx: &mut Context<Self>) {
        if self.last_refresh.elapsed() >= Duration::from_secs(300) {
            self.load(cx);
        }
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        self.last_refresh = Instant::now();
        let revision = self.revision;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let all = self.all;
        let task = cx.background_executor().spawn(async move {
            let mut query = vec![
                ("scope", "all"),
                ("includeDismissed", "1"),
                ("includeMaintainer", "1"),
            ];
            if !all {
                query.push(("maintainerRepoPath", workspace.as_str()));
            }
            (
                client.get::<InboxResponse>("/api/panel/supervisor-inbox", &query),
                client.get::<ApprovalsResponse>(
                    "/api/panel/approvals",
                    &[("status", "pending"), ("scope", "all")],
                ),
            )
        });
        cx.spawn(async move |this, cx| {
            let (inbox, approvals) = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                if revision != this.revision { this.load(cx); return; }
                match inbox {
                    Ok(inbox) => {
                        this.items = inbox.items;
                        this.errors[0] = None;
                        this.errors[1] = inbox.maintainer_error;
                        if let Some(feed) = inbox.maintainer { this.feed = feed; }
                        else if this.errors[1].is_none() { this.errors[1] = Some("Connected GitHub data is unavailable. Refresh the inbox.".into()); }
                    }
                    Err(error) => this.errors[0] = Some(format!("Inbox could not be refreshed. Previous items are still shown. {error}")),
                }
                match approvals {
                    Ok(approvals) => { this.approvals = approvals.approvals; this.errors[2] = None; this.uncertain.clear(); }
                    Err(error) => this.errors[2] = Some(format!("Approvals could not be refreshed. Previous approvals are still shown. {error}")),
                }
                this.loaded = true;
                this.rebuild(cx);
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let scoped = |item: &&Value| {
            if !item["problemDossierId"].is_null()
                && item["problemDossierId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            {
                return false;
            }
            if self.all {
                return true;
            }
            if item["kind"] == "outside_human_waiting" {
                if let Some(source) = self
                    .feed
                    .sources
                    .iter()
                    .find(|s| s["repo"] == text(&item["payload"], "threadRepo").to_lowercase())
                {
                    return source["repoPaths"]
                        .as_array()
                        .is_some_and(|paths| paths.iter().any(|p| p == &self.workspace));
                }
            }
            item["repoPath"] == self.workspace
        };
        let items = self.items.iter().filter(scoped).collect::<Vec<_>>();
        let outside = items
            .iter()
            .copied()
            .filter(|i| i["kind"] == "outside_human_waiting")
            .collect::<Vec<_>>();
        let key = |item: &Value, incident: bool| {
            if incident {
                format!(
                    "{}:{}:{}",
                    text(&item["payload"], "threadRepo").to_lowercase(),
                    text(&item["payload"], "threadKind"),
                    item["payload"]["threadNumber"]
                )
            } else {
                format!(
                    "{}:{}:{}",
                    text(item, "repo").to_lowercase(),
                    text(item, "threadKind"),
                    item["number"]
                )
            }
        };
        let matches_scope = |item: &&Value| {
            self.all
                || item["repoPaths"]
                    .as_array()
                    .is_some_and(|paths| paths.iter().any(|p| p == &self.workspace))
        };
        let snapshots = self
            .feed
            .replies
            .iter()
            .filter(matches_scope)
            .collect::<Vec<_>>();
        let mut replies = outside
            .iter()
            .copied()
            .filter(|i| {
                active(i)
                    && !snapshots.iter().any(|s| {
                        key(i, true) == key(s, false)
                            && s["waitingSince"] != i["payload"]["waitingSince"]
                    })
            })
            .map(|i| {
                (
                    i["payload"]["waitingSince"]
                        .as_str()
                        .or(i["createdAt"].as_str())
                        .unwrap_or("")
                        .to_owned(),
                    Card::incident(i),
                )
            })
            .collect::<Vec<_>>();
        for snapshot in snapshots {
            if !outside.iter().any(|i| {
                key(i, true) == key(snapshot, false)
                    && i["payload"]["waitingSince"] == snapshot["waitingSince"]
            }) {
                replies.push((
                    snapshot["waitingSince"]
                        .as_str()
                        .or(snapshot["createdAt"].as_str())
                        .unwrap_or("")
                        .to_owned(),
                    Card::contribution(snapshot),
                ));
            }
        }
        replies.sort_by(|(a, ac), (b, bc)| a.cmp(b).then(ac.id.cmp(&bc.id)));
        self.cards = [
            replies.into_iter().map(|(_, c)| c).collect(),
            self.feed
                .contributions
                .iter()
                .filter(matches_scope)
                .map(Card::contribution)
                .collect(),
            self.approvals.iter().map(Card::approval).collect(),
            items
                .iter()
                .copied()
                .filter(|i| active(i) && i["kind"] != "outside_human_waiting")
                .map(Card::incident)
                .collect(),
            items
                .iter()
                .copied()
                .filter(|i| !active(i))
                .map(Card::incident)
                .collect(),
        ];
        self.selected = self
            .selected
            .min(self.cards[self.lane].len().saturating_sub(1));
        self.action_focus.retain(|id, _| {
            self.approvals
                .iter()
                .any(|approval| approval["id"] == id.as_str())
        });
        for card in &self.cards[2] {
            self.action_focus
                .entry(card.id.clone())
                .or_insert_with(|| [cx.focus_handle(), cx.focus_handle()]);
        }
    }
    pub(crate) fn select_lane(&mut self, lane: usize, cx: &mut Context<Self>) {
        self.lane = lane;
        self.selected = 0;
        self.scroll.scroll_to_item(0);
        cx.notify();
    }
    pub(crate) fn scope(&mut self, cx: &mut Context<Self>) {
        if self.lane == 2 || self.workspace.is_empty() {
            return;
        }
        self.all = !self.all;
        self.revision += 1;
        self.items.clear();
        self.feed = Feed::default();
        self.rebuild(cx);
        self.loaded = false;
        self.load(cx);
        cx.notify();
    }
    pub(crate) fn can_resolve(&self, card: &Card) -> bool {
        card.approval
            && card.status == "pending"
            && !card.unsettled
            && self.busy.is_none()
            && !self.uncertain.contains(&card.id)
    }
    pub(crate) fn decide(
        &mut self,
        card: Card,
        approve: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_resolve(&card) {
            return;
        }
        self.focus.focus(window);
        let id = card.id;
        self.busy = Some(id.clone());
        self.notice = if approve {
            "Approving…"
        } else {
            "Rejecting…"
        }
        .into();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.inbox_decision(&id, approve) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(id) = this.busy.take() {
                    this.uncertain.insert(id);
                }
                this.notice = match result {
                    Ok(body) => body["note"]
                        .as_str()
                        .unwrap_or(if approve { "Approved." } else { "Rejected." })
                        .into(),
                    Err(error) => error,
                };
                this.revision += 1;
                this.load(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(crate) fn open(&mut self, card: &Card, cx: &mut Context<Self>) {
        if !card.session.is_empty() {
            cx.emit(OpenSession(card.session.clone()));
        } else if let Some(url) = github_url(&card.url) {
            cx.open_url(&url);
        } else {
            self.notice = "Related session or GitHub thread is unavailable.".into();
            cx.notify();
        }
    }
    pub(crate) fn error(&self) -> Option<&str> {
        self.errors[0].as_deref().or_else(|| match self.lane {
            0 | 1 => self.errors[1].as_deref(),
            2 => self.errors[2].as_deref(),
            _ => None,
        })
    }
    pub(crate) fn freshness(&self) -> String {
        if self.feed.sources.is_empty() {
            return "GitHub replies appear after a connected repository syncs.".into();
        }
        if self
            .feed
            .sources
            .iter()
            .any(|source| !source["lastSuccessfulAt"].is_string())
        {
            return "Some repositories have not synced yet.".into();
        }
        let oldest = self
            .feed
            .sources
            .iter()
            .filter_map(|s| s["lastSuccessfulAt"].as_str())
            .min();
        let prefix = if self.feed.sources.iter().any(|s| s["stale"] == true) {
            "Cached GitHub data"
        } else {
            "GitHub synced"
        };
        oldest
            .map(|date| format!("{prefix} · {date}"))
            .unwrap_or_else(|| "Some repositories have not synced yet.".into())
    }
    pub(crate) fn truncated(&self) -> bool {
        self.lane == 0 && self.feed.replies_truncated || self.lane == 1 && self.feed.truncated
    }
}

#[path = "inbox_view.rs"]
mod view;
fn github_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}
