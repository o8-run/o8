use super::*;
use crate::activity::Step;
use crate::motion::Transition;
use gpui::SharedString;
use serde_json::Value;
use std::time::Instant;
// The Activity Dock: a toolbar of activity tabs floating at the top right of
// the chat column. A tab grows the toolbar into a card for that tab; its links
// open the right panel or a surface. The header's Activity toggle shows it.
struct ActivityDock;
register_shell_feature!(ActivityDock);
impl ShellFeature for ActivityDock {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 55,
            run: |s, _, _, cx| tick(s, cx),
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 40,
            dispatch: |s, event, window, cx| {
                let open = s
                    .features
                    .read::<Dock>()
                    .is_some_and(|dock| dock.card.is_open());
                if open && event.keystroke.key == "escape" {
                    s.features.get::<Dock>().card.set(false);
                    s.restore_focus(window, cx);
                    cx.notify();
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pane {
    Plan,
    Changes,
    Tasks,
    Branch,
    Files,
    Ports,
}

impl Pane {
    const ALL: [Pane; 6] = [
        Pane::Plan,
        Pane::Changes,
        Pane::Tasks,
        Pane::Branch,
        Pane::Files,
        Pane::Ports,
    ];
    fn name(self) -> &'static str {
        match self {
            Pane::Plan => "plan",
            Pane::Changes => "changes",
            Pane::Tasks => "tasks",
            Pane::Branch => "branch",
            Pane::Files => "files",
            Pane::Ports => "ports",
        }
    }
    fn tip(self) -> &'static str {
        match self {
            Pane::Plan => "Plan",
            Pane::Changes => "Changes",
            Pane::Tasks => "Tasks",
            Pane::Branch => "Branch",
            Pane::Files => "Files",
            Pane::Ports => "Ports",
        }
    }
}

const PILL_H: f32 = 38.;
const BUTTON_W: f32 = 30.;
const CARD_W: f32 = 340.;
const ROW: f32 = 30.;
const TITLE: f32 = 42.;

#[derive(Clone, Default)]
struct ChangedFile {
    path: String,
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Clone, Default)]
struct PullRequest {
    number: u64,
    title: String,
    state: String,
    draft: bool,
    url: String,
    author: Option<String>,
    comments: Option<u64>,
    checks: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    files: Option<u64>,
    updated: Option<String>,
}

#[derive(Clone)]
struct Worktree {
    path: String,
    branch: Option<String>,
    current: bool,
}

#[derive(Clone)]
struct Packet {
    title: String,
    status: String,
    started: Option<f64>,
}

#[derive(Default)]
struct Data {
    branch: Option<String>,
    repo: Option<String>,
    path: Option<String>,
    files: Vec<ChangedFile>,
    ahead: u64,
    behind: u64,
    pull_request: Option<PullRequest>,
    worktrees: Vec<Worktree>,
    ports: Vec<(u64, String)>,
    packets: Vec<Packet>,
    inbox: u64,
}

struct Dock {
    /// The toolbar's appearance from the header toggle: 180ms.
    shown: Transition,
    /// Toolbar to card: 240ms.
    card: Transition,
    /// A tab change inside the open card: 180ms slide and height change.
    swap: Transition,
    pane: Pane,
    /// The body height the card is leaving during a tab change.
    from_height: f32,
    scope: Option<String>,
    data: Data,
    loaded: Option<Instant>,
    /// When each running step was first seen, for steps without saved times.
    seen: std::collections::HashMap<String, f64>,
    spin: Instant,
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            shown: Transition::new(180),
            card: Transition::new(240),
            swap: Transition::new(180),
            pane: Pane::Plan,
            from_height: 0.,
            scope: None,
            data: Data::default(),
            loaded: None,
            seen: Default::default(),
            spin: Instant::now(),
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |d| d.as_millis() as f64)
}

/// The conversation's plan and tasks, read from the active session's steps.
struct Turn {
    todos: Vec<(String, String)>,
    tasks: Vec<(String, String, f64, Option<f64>)>,
}

fn turn(s: &Shell, cx: &App) -> Turn {
    let steps: Vec<Step> = match s.active().and_then(|tab| s.content.get(&s.key(&tab))) {
        Some(Content::Session(view)) => view.read(cx).shell_steps().0,
        _ => vec![],
    };
    let todos = steps
        .iter()
        .rev()
        .find(|step| !step.todos.is_empty())
        .map(|step| step.todos.clone())
        .unwrap_or_default();
    let seen = s.features.read::<Dock>().map(|dock| &dock.seen);
    let tasks = steps
        .iter()
        .filter(|step| step.group_key == "agent")
        .rev()
        .take(6)
        .map(|step| {
            let title = step
                .parts
                .first()
                .and_then(|part| part.subject.clone().or_else(|| Some(part.text.clone())))
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| step.command.clone());
            let started = step
                .started
                .or_else(|| seen.and_then(|seen| seen.get(&step.id).copied()))
                .unwrap_or_else(now_ms);
            (
                step.id.clone(),
                title,
                started,
                step.finished
                    .or((step.status != "running").then_some(started)),
            )
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Turn { todos, tasks }
}

fn tick(s: &mut Shell, cx: &mut Context<Shell>) {
    let dock = s.features.get::<Dock>();
    // Hidden, the data still refreshes slowly, so the toolbar opens with
    // every tab instead of growing as the first loads return.
    let every = if dock.shown.is_open() { 5 } else { 60 };
    let stale = dock.loaded.is_none_or(|at| at.elapsed().as_secs() >= every)
        || dock.scope != s.state.selected;
    if !dock.shown.is_open() {
        if stale {
            load(s, cx);
        }
        return;
    }
    // Running steps without saved times count from when the dock first saw them.
    let running: Vec<String> = match s.active().and_then(|tab| s.content.get(&s.key(&tab))) {
        Some(Content::Session(view)) => view
            .read(cx)
            .shell_steps()
            .0
            .into_iter()
            .filter(|step| step.status == "running" && step.started.is_none())
            .map(|step| step.id)
            .collect(),
        _ => vec![],
    };
    let dock = s.features.get::<Dock>();
    for id in running {
        dock.seen.entry(id).or_insert_with(now_ms);
    }
    if stale {
        load(s, cx);
    }
    // Elapsed counters and the plan's spinner move while the card is open.
    cx.notify();
}

fn read_snapshot(data: &mut Data, body: &Value) {
    let text = |value: &Value| value.as_str().filter(|s| !s.is_empty()).map(String::from);
    data.branch = text(&body["branch"]);
    data.repo = text(&body["repoSlug"]);
    data.path = text(&body["repoPath"]);
    data.ahead = body["ahead"].as_u64().unwrap_or(0);
    data.behind = body["behind"].as_u64().unwrap_or(0);
    data.files = body["changedFiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            Some(ChangedFile {
                path: file["path"].as_str()?.to_string(),
                additions: file["additions"].as_u64(),
                deletions: file["deletions"].as_u64(),
            })
        })
        .collect();
    if let Some(trees) = body["worktrees"]
        .as_array()
        .filter(|trees| !trees.is_empty())
    {
        // Agent scratch worktrees stay out of the list unless current.
        data.worktrees = trees
            .iter()
            .filter_map(|tree| {
                let path = tree["absolutePath"]
                    .as_str()
                    .or(tree["path"].as_str())?
                    .to_string();
                let current = tree["isCurrent"] == true;
                (current || !path.contains("/.claude/worktrees/agent-")).then(|| Worktree {
                    path,
                    branch: tree["branch"].as_str().map(String::from),
                    current,
                })
            })
            .collect();
    }
    let found = body["pullRequests"].as_array().and_then(|prs| {
        prs.iter()
            .find(|pr| pr["headRefName"].as_str() == data.branch.as_deref())
            .cloned()
    });
    if let Some(pr) = found {
        let mut next = data
            .pull_request
            .take()
            .filter(|old| Some(old.number) == pr["number"].as_u64())
            .unwrap_or_default();
        next.number = pr["number"].as_u64().unwrap_or(0);
        next.title = pr["title"].as_str().unwrap_or("").to_string();
        next.state = pr["state"].as_str().unwrap_or("").to_lowercase();
        next.draft = pr["isDraft"] == true;
        next.url = pr["url"].as_str().unwrap_or("").to_string();
        data.pull_request = Some(next);
    } else if body
        .get("pullRequests")
        .is_some_and(|prs| prs.as_array().is_some_and(|prs| !prs.is_empty()))
    {
        data.pull_request = None;
    }
}

/// The pull request row from the PR list: author, totals, checks, comments.
fn read_pull_details(data: &mut Data, body: &Value) {
    let Some(pr) = data.pull_request.as_mut() else {
        return;
    };
    let Some(row) = body["prs"]
        .as_array()
        .or(body["items"].as_array())
        .or(body.as_array())
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["number"].as_u64() == Some(pr.number))
        })
    else {
        return;
    };
    let author = &row["author"];
    pr.author = author["login"]
        .as_str()
        .or(author.as_str())
        .map(String::from);
    pr.comments = row["comments"].as_u64().or(row["commentCount"].as_u64());
    pr.checks = row["checks"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from);
    pr.additions = row["additions"].as_u64();
    pr.deletions = row["deletions"].as_u64();
    pr.files = row["changedFiles"].as_u64().or(row["files"].as_u64());
    pr.updated = row["updatedAt"]
        .as_str()
        .or(row["createdAt"].as_str())
        .map(String::from);
}

fn read_ports(data: &mut Data, body: &Value) {
    data.ports = body["ports"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|port| port["kind"] == "page")
        .filter_map(|port| {
            let label = port["label"].as_str().unwrap_or("Local page");
            let label = match port["repo"].as_str() {
                Some(repo) if !repo.is_empty() => format!("{label} · {repo}"),
                _ => label.to_string(),
            };
            Some((port["port"].as_u64()?, label))
        })
        .collect();
}

fn read_packets(data: &mut Data, body: &Value, workspace: &str) {
    data.packets = body["mission"]["packets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|packet| {
            packet["workspaceTargetPath"]
                .as_str()
                .is_some_and(|path| crate::client::same_workspace(path, workspace))
        })
        .filter(|packet| {
            matches!(
                packet["status"].as_str().unwrap_or(""),
                "running" | "dispatched" | "awaiting_review" | "blocked"
            )
        })
        .map(|packet| Packet {
            title: packet["title"]
                .as_str()
                .or(packet["referenceLabel"].as_str())
                .unwrap_or("Worker")
                .to_string(),
            status: packet["status"].as_str().unwrap_or("").replace('_', " "),
            started: packet["startedAt"]
                .as_f64()
                .or(packet["dispatchedAt"].as_f64()),
        })
        .collect();
}

fn read_inbox(data: &mut Data, body: &Value) {
    data.inbox = body["summary"]["humanRequired"].as_u64().unwrap_or(0);
}

fn load(s: &mut Shell, cx: &mut Context<Shell>) {
    let Some(workspace) = s.state.selected.clone() else {
        return;
    };
    let dock = s.features.get::<Dock>();
    if dock.scope.as_deref() != Some(workspace.as_str()) {
        dock.data = Data::default();
    }
    dock.scope = Some(workspace.clone());
    dock.loaded = Some(Instant::now());
    let client = s.client.in_workspace(&workspace);
    type Apply = fn(&mut Data, &Value, &str);
    let side: [(&'static str, Vec<(&'static str, String)>, Apply); 5] = [
        (
            "/api/review/workspace",
            vec![
                ("workspace", workspace.clone()),
                ("changesOnly", "1".into()),
            ],
            |data, body, _| read_snapshot(data, body),
        ),
        // Again with pull requests, the slow `gh` path.
        (
            "/api/review/workspace",
            vec![("workspace", workspace.clone())],
            |data, body, _| read_snapshot(data, body),
        ),
        ("/api/panel/ports", vec![], |data, body, _| {
            read_ports(data, body)
        }),
        ("/api/orchestrator/state", vec![], read_packets),
        (
            "/api/panel/supervisor-inbox",
            vec![("scope", "all".into())],
            |data, body, _| read_inbox(data, body),
        ),
    ];
    for (route, query, apply) in side {
        let client = client.clone();
        let task = cx.background_executor().spawn(async move {
            let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
            client.get::<Value>(route, &query)
        });
        let scope = workspace.clone();
        cx.spawn(async move |this, cx| {
            let Ok(body) = task.await else { return };
            let _ = this.update(cx, |this, cx| {
                let dock = this.features.get::<Dock>();
                if dock.scope.as_deref() != Some(scope.as_str()) {
                    return;
                }
                apply(&mut dock.data, &body, &scope);
                // A pull request found on this branch loads its row for the card.
                if route == "/api/review/workspace" && dock.data.pull_request.is_some() {
                    load_pull_details(this, scope.clone(), cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

fn load_pull_details(s: &mut Shell, workspace: String, cx: &mut Context<Shell>) {
    let client = s.client.in_workspace(&workspace);
    let task = cx.background_executor().spawn({
        let workspace = workspace.clone();
        async move {
            client.get::<Value>(
                "/api/panel/prs",
                &[
                    ("repoPath", workspace.as_str()),
                    ("view", "list"),
                    ("state", "all"),
                ],
            )
        }
    });
    cx.spawn(async move |this, cx| {
        let Ok(body) = task.await else { return };
        let _ = this.update(cx, |this, cx| {
            let dock = this.features.get::<Dock>();
            if dock.scope.as_deref() == Some(workspace.as_str()) {
                read_pull_details(&mut dock.data, &body);
                cx.notify();
            }
        });
    })
    .detach();
}

pub(super) fn is_shown(s: &Shell) -> bool {
    s.features
        .read::<Dock>()
        .is_some_and(|dock| dock.shown.is_open())
}

fn toggle(s: &mut Shell, cx: &mut Context<Shell>) {
    let dock = s.features.get::<Dock>();
    let show = !dock.shown.is_open();
    dock.shown.set(show);
    if !show {
        dock.card.set(false);
    }
    if show {
        load(s, cx);
    }
    cx.notify();
}

/// Opens `pane` in the card, or folds the card back to the toolbar when it is
/// the open pane already.
fn select(s: &mut Shell, pane: Pane, window: &mut Window, cx: &mut Context<Shell>) {
    let height = body_height(s, cx);
    let dock = s.features.get::<Dock>();
    if dock.card.is_open() && dock.pane == pane {
        dock.card.set(false);
    } else if dock.card.is_open() {
        dock.from_height = height;
        dock.swap = Transition::new(180);
        dock.swap.set(true);
        dock.pane = pane;
    } else {
        dock.pane = pane;
        dock.swap = Transition::new(0);
        dock.swap.set(true);
        dock.card.set(true);
    }
    window.refresh();
    cx.notify();
}

/// The tabs that have something to show, in toolbar order.
fn panes(s: &Shell, turn: &Turn) -> Vec<Pane> {
    let Some(dock) = s.features.read::<Dock>() else {
        return vec![];
    };
    let data = &dock.data;
    Pane::ALL
        .into_iter()
        .filter(|pane| match pane {
            Pane::Plan => !turn.todos.is_empty(),
            Pane::Changes => !data.files.is_empty(),
            Pane::Tasks => !turn.tasks.is_empty() || !data.packets.is_empty() || data.inbox > 0,
            Pane::Branch => data.branch.is_some(),
            Pane::Files => s.state.selected.is_some(),
            Pane::Ports => !data.ports.is_empty(),
        })
        .collect()
}

/// The header's Activity toggle.
pub(super) fn toggle_button(s: &Shell, cx: &mut Context<Shell>) -> gpui::Stateful<gpui::Div> {
    let shown = is_shown(s);
    // One label: a tooltip keeps the text it opened with while the pointer
    // stays, so a show/hide label read backwards right after each click.
    super::header::pill("header-activity", "Activity", true)
    .w(px(30.))
    .when(shown, |pill| pill.bg(theme().hover))
    .child(crate::icon::stroke(
        ACTIVITY,
        if shown {
            theme().text
        } else {
            theme().text_secondary
        },
        16.,
        1.8,
    ))
    .on_click(cx.listener(|this, _, window, cx| {
        this.capture(window, cx);
        toggle(this, cx);
    }))
}

fn mono(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.to_string()
}

/// Two or three letters for a file's language badge.
fn badge(path: &str) -> String {
    let ext = path.rsplit_once('.').map_or("", |(_, ext)| ext);
    match ext {
        "ts" | "tsx" => "TS".into(),
        "js" | "jsx" | "mjs" | "cjs" => "JS".into(),
        "rs" => "RS".into(),
        "md" => "MD".into(),
        "json" => "{}".into(),
        "py" => "PY".into(),
        "css" => "CSS".into(),
        "html" => "<>".into(),
        "sh" => "SH".into(),
        "" => "·".into(),
        other => other.chars().take(2).collect::<String>().to_uppercase(),
    }
}

fn elapsed(started: f64, finished: Option<f64>) -> String {
    let seconds = ((finished.unwrap_or_else(now_ms) - started) / 1000.)
        .max(0.)
        .floor() as u64;
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {}m", seconds / 3600, seconds % 3600 / 60)
    }
}

/// Epoch milliseconds for GitHub's UTC timestamps ("2026-10-08T14:03:11Z").
fn epoch_ms(iso: &str) -> Option<f64> {
    let number = |range: std::ops::Range<usize>| iso.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) as f64)
}

/// "3w ago" from an ISO timestamp.
fn age(iso: &str) -> Option<String> {
    let then = epoch_ms(iso)?;
    let seconds = ((now_ms() - then) / 1000.).max(0.) as u64;
    Some(match seconds {
        0..60 => "now".into(),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86_400 => format!("{}h ago", seconds / 3600),
        86_400..604_800 => format!("{}d ago", seconds / 86_400),
        _ => format!("{}w ago", seconds / 604_800),
    })
}

/// The open card's body height for its pane, for the height animation.
fn body_height(s: &Shell, cx: &App) -> f32 {
    let Some(dock) = s.features.read::<Dock>() else {
        return 0.;
    };
    let turn = turn(s, cx);
    pane_height(dock.pane, &dock.data, &turn)
}

const MAX_FILES: usize = 4;

fn pane_height(pane: Pane, data: &Data, turn: &Turn) -> f32 {
    let rows = |n: usize| n as f32 * ROW;
    TITLE
        + 10.
        + match pane {
            Pane::Plan => rows(turn.todos.len()),
            Pane::Changes => {
                let more = data.files.len() > MAX_FILES;
                54. + 26.
                    + 24.
                    + rows(data.files.len().min(MAX_FILES))
                    + if more { 24. } else { 0. }
                    + 44.
            }
            Pane::Tasks => {
                rows(turn.tasks.len() + data.packets.len() + usize::from(data.inbox > 0)).max(ROW)
            }
            Pane::Branch => {
                ROW + if data.pull_request.is_some() { 98. } else { 0. }
                    + rows(2)
                    + if data.pull_request.is_none() {
                        rows(data.worktrees.len().min(4))
                    } else {
                        0.
                    }
            }
            Pane::Files => rows(2 + data.worktrees.len().min(4)),
            Pane::Ports => rows(data.ports.len()),
        }
}

/// The dock over the chat column while it is shown or moving.
pub(super) fn element(s: &Shell, window: &Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let dock = s.features.read::<Dock>()?;
    let (shown, appearing) = dock.shown.value();
    if shown <= 0. && !appearing {
        return None;
    }
    let turn = turn(s, cx);
    let panes = panes(s, &turn);
    if panes.is_empty() {
        return None;
    }
    let (open, opening) = dock.card.value();
    let (swap, swapping) = dock.swap.value();
    let live_tasks = turn.tasks.iter().any(|task| task.3.is_none());
    let plan_running = turn.todos.iter().any(|(_, status)| status == "in_progress");
    if appearing || opening || swapping || (open > 0. && plan_running) {
        window.request_animation_frame();
    }
    let _ = live_tasks;
    let pane = if panes.contains(&dock.pane) {
        dock.pane
    } else {
        panes[0]
    };
    let pill_w = panes.len() as f32 * (BUTTON_W + 4.) + 8.;
    let target = pane_height(pane, &dock.data, &turn);
    let body_h = if swap < 1. {
        dock.from_height + (target - dock.from_height) * swap
    } else {
        target
    };
    let width = pill_w + (CARD_W - pill_w) * open;
    let height = PILL_H + (body_h + 1.) * open;
    let spin = dock.spin.elapsed().as_secs_f32() * std::f32::consts::TAU * 0.8;
    let remaining = turn
        .todos
        .iter()
        .filter(|(_, status)| status != "completed")
        .count();

    let toolbar = div()
        .h(px(PILL_H))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(4.))
        .px(px(4.))
        .children(panes.iter().map(|&each| {
            let selected = open > 0.5 && each == pane;
            let tint = match each {
                Pane::Plan if plan_running => theme().accent,
                _ if selected => theme().text,
                _ => theme().text_secondary,
            };
            let icon = match each {
                Pane::Plan => PLAN,
                Pane::Changes => CHANGES,
                Pane::Tasks => TASKS,
                Pane::Branch if dock.data.pull_request.is_some() => PULL,
                Pane::Branch => BRANCH,
                Pane::Files => FOLDER,
                Pane::Ports => PORTS,
            };
            let badge = match each {
                Pane::Plan if remaining > 0 => Some(remaining as u64),
                Pane::Tasks if dock.data.inbox > 0 => Some(dock.data.inbox),
                _ => None,
            };
            div()
                .id(SharedString::from(format!("activity-tab-{}", each.name())))
                .debug_selector(move || format!("activity-tab-{}", each.name()))
                .relative()
                .w(px(BUTTON_W))
                .h(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(8.))
                .cursor_pointer()
                .when(selected, |button| button.bg(theme().hover))
                .hover(|button| button.bg(theme().hover))
                .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(each.tip().into())).into())
                .child(crate::icon::stroke(icon, tint, 16., 1.7))
                .when_some(badge, |button, count| {
                    button.child(
                        div()
                            .absolute()
                            .top(px(-3.))
                            .right(px(-2.))
                            .min_w(px(15.))
                            .h(px(15.))
                            .px(px(4.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(8.))
                            .bg(theme().danger)
                            .border_1()
                            .border_color(crate::theme::popover_background())
                            .text_size(px(9.5))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(gpui::white())
                            .child(count.to_string()),
                    )
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.capture(window, cx);
                    select(this, each, window, cx);
                }))
        }));

    let fade = ((open - 0.35) / 0.65).clamp(0., 1.) * if swap < 1. { swap } else { 1. };
    let body = (open > 0.).then(|| {
        div()
            .w(px(CARD_W))
            .h(px(body_h))
            .flex_shrink_0()
            .overflow_hidden()
            .border_t_1()
            .border_color(theme().border)
            .child(
                div()
                    .relative()
                    .left(px(if swap < 1. { 14. * (1. - swap) } else { 0. }))
                    .top(px(4. * (1. - open)))
                    .opacity(fade)
                    .px(px(14.))
                    .child(match pane {
                        Pane::Plan => plan(&turn, spin).into_any_element(),
                        Pane::Changes => changes(&dock.data, cx).into_any_element(),
                        Pane::Tasks => tasks(&turn, &dock.data, cx).into_any_element(),
                        Pane::Branch => branch(&dock.data, cx).into_any_element(),
                        Pane::Files => files(&dock.data, cx).into_any_element(),
                        Pane::Ports => ports(&dock.data, cx).into_any_element(),
                    }),
            )
    });

    Some(
        div()
            .absolute()
            .top(px(10. - 4. * (1. - shown)))
            .right(px(12.))
            .opacity(shown)
            .child(
                div()
                    .id("activity-dock")
                    .debug_selector(|| "activity-dock".into())
                    .occlude()
                    .w(px(width))
                    .h(px(height))
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .items_end()
                    .rounded(px(11. + 3. * open))
                    .bg(crate::theme::popover_background())
                    .border_1()
                    .border_color(theme().border)
                    .when(open > 0., |card| card.shadow_lg())
                    .when(open <= 0., |pill| pill.shadow_md())
                    .text_size(px(13.))
                    .text_color(theme().text)
                    .child(toolbar)
                    .children(body),
            )
            .into_any_element(),
    )
}

/// The card's title row: title left, summary right, hairline under it.
fn title(text: &str, summary: impl IntoElement) -> gpui::Div {
    div()
        .h(px(TITLE))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .border_b_1()
        .border_color(theme().border)
        .child(
            div()
                .text_size(px(13.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(theme().text)
                .child(text.to_string()),
        )
        .child(
            div()
                .text_size(px(12.5))
                .text_color(theme().text_muted)
                .child(summary),
        )
}

fn row(id: impl Into<SharedString>) -> gpui::Stateful<gpui::Div> {
    let id: SharedString = id.into();
    let selector = id.to_string();
    div()
        .id(id)
        .debug_selector(move || selector.clone())
        .h(px(ROW))
        .flex()
        .items_center()
        .gap(px(10.))
        .mx(px(-6.))
        .px(px(6.))
        .rounded(px(7.))
}

fn ellipsis(text: impl Into<SharedString>) -> gpui::Div {
    div()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .child(text.into())
}

fn totals(additions: Option<u64>, deletions: Option<u64>) -> gpui::Div {
    div()
        .flex()
        .flex_shrink_0()
        .gap(px(5.))
        .text_size(px(12.5))
        .when_some(additions.filter(|n| *n > 0), |row, n| {
            row.child(div().text_color(theme().success).child(format!("+{n}")))
        })
        .when_some(deletions.filter(|n| *n > 0), |row, n| {
            row.child(div().text_color(theme().danger).child(format!("−{n}")))
        })
}

fn plan(turn: &Turn, spin: f32) -> impl IntoElement {
    let done = turn
        .todos
        .iter()
        .filter(|(_, status)| status == "completed")
        .count();
    let current = turn
        .todos
        .iter()
        .position(|(_, status)| status == "in_progress");
    let summary = if done == turn.todos.len() {
        "Done".to_string()
    } else {
        format!(
            "{} of {}",
            (done + 1).min(turn.todos.len()),
            turn.todos.len()
        )
    };
    div().child(title("Plan", summary)).child(
        div().pt(px(6.)).children(
            turn.todos
                .iter()
                .enumerate()
                .map(|(index, (text, status))| {
                    let (icon, color, weight, tone) = match status.as_str() {
                        "completed" => (
                            CHECK,
                            theme().success,
                            gpui::FontWeight::LIGHT,
                            theme().text_muted,
                        ),
                        "in_progress" => (
                            SPINNER,
                            theme().accent,
                            gpui::FontWeight::MEDIUM,
                            theme().text,
                        ),
                        _ => (
                            CIRCLE,
                            theme().text_faint,
                            gpui::FontWeight::LIGHT,
                            theme().text_muted,
                        ),
                    };
                    let icon = crate::icon::stroke(icon, color, 15., 1.7);
                    let icon = if Some(index) == current {
                        icon.with_transformation(gpui::Transformation::rotate(gpui::radians(spin)))
                    } else {
                        icon
                    };
                    row(SharedString::from(format!("activity-plan-{index}")))
                        .child(div().flex_shrink_0().child(icon))
                        .child(ellipsis(text.clone()).font_weight(weight).text_color(tone))
                }),
        ),
    )
}

fn changes(data: &Data, cx: &mut Context<Shell>) -> impl IntoElement {
    let additions: u64 = data.files.iter().filter_map(|file| file.additions).sum();
    let deletions: u64 = data.files.iter().filter_map(|file| file.deletions).sum();
    let count = data.files.len();
    let noun = if count == 1 { "file" } else { "files" };
    div()
        .child(title(
            "Changes by destination",
            div()
                .flex()
                .gap(px(6.))
                .child(format!("{count} {noun}"))
                .child(totals(Some(additions), Some(deletions))),
        ))
        .child(
            div()
                .pt(px(10.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_color(theme().text_secondary)
                        .child(crate::icon::stroke(REPO, theme().text_muted, 13., 1.7))
                        .child(div().flex_1().child("Repositories"))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme().text_muted)
                                .child(format!("{count} {noun}")),
                        ),
                )
                .child(
                    div()
                        .pl(px(21.))
                        .text_size(px(12.))
                        .text_color(theme().text_muted)
                        .child("Publish through a pull request on GitHub."),
                ),
        )
        .child(
            div()
                .pt(px(10.))
                .text_size(px(13.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(
                    data.repo
                        .clone()
                        .unwrap_or_else(|| "This repository".into()),
                ),
        )
        .child(
            row("activity-changes-branch")
                .h(px(24.))
                .text_size(px(12.5))
                .text_color(theme().text_muted)
                .child(crate::icon::stroke(BRANCH, theme().text_muted, 12., 1.7))
                .child(div().child(data.branch.clone().unwrap_or_default()))
                .child(crate::icon::stroke(OUT, theme().text_muted, 11., 1.7)),
        )
        .children(
            data.files
                .iter()
                .take(MAX_FILES)
                .enumerate()
                .map(|(index, file)| {
                    row(SharedString::from(format!("activity-change-{index}")))
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .child(
                            div()
                                .flex_shrink_0()
                                .min_w(px(20.))
                                .h(px(15.))
                                .px(px(3.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.))
                                .bg(theme().hover)
                                .text_size(px(8.5))
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(theme().accent)
                                .child(badge(&file.path)),
                        )
                        .child(ellipsis(mono(&file.path)).text_color(theme().text_secondary))
                        .child(totals(file.additions, file.deletions))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.capture(window, cx);
                            super::right_panel::open_review(this, window, cx);
                        }))
                }),
        )
        .when(data.files.len() > MAX_FILES, |list| {
            list.child(
                div()
                    .h(px(24.))
                    .pl(px(30.))
                    .flex()
                    .items_center()
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child(format!(
                        "+{} more in this source",
                        data.files.len() - MAX_FILES
                    )),
            )
        })
        .child(
            div()
                .mt(px(8.))
                .border_t_1()
                .border_color(theme().border)
                .child(
                    row("activity-see-changes")
                        .h(px(34.))
                        .mt(px(4.))
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .text_color(theme().text_secondary)
                        .child(div().flex_1().child("See all changes"))
                        .child(crate::icon::stroke(OUT, theme().text_muted, 12., 1.7))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.capture(window, cx);
                            super::right_panel::open_review(this, window, cx);
                        })),
                ),
        )
}

fn tasks(turn: &Turn, data: &Data, cx: &mut Context<Shell>) -> impl IntoElement {
    let running = turn.tasks.iter().filter(|task| task.3.is_none()).count() + data.packets.len();
    div()
        .child(title(
            "Tasks",
            if running > 0 {
                format!("{running} running")
            } else {
                String::new()
            },
        ))
        .child(
            div()
                .pt(px(6.))
                .children(turn.tasks.iter().map(|(id, text, started, finished)| {
                    row(SharedString::from(format!("activity-task-{id}")))
                        .child(crate::icon::stroke(
                            TASKS,
                            if finished.is_none() {
                                theme().accent
                            } else {
                                theme().text_muted
                            },
                            14.,
                            1.7,
                        ))
                        .child(ellipsis(text.clone()).text_color(theme().text_secondary))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(12.5))
                                .text_color(theme().text_muted)
                                .child(elapsed(*started, *finished)),
                        )
                }))
                .children(data.packets.iter().enumerate().map(|(index, packet)| {
                    row(SharedString::from(format!("activity-worker-{index}")))
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .child(crate::icon::stroke(TASKS, theme().accent, 14., 1.7))
                        .child(ellipsis(packet.title.clone()).text_color(theme().text_secondary))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(12.5))
                                .text_color(theme().text_muted)
                                .child(
                                    packet.started.map_or_else(
                                        || packet.status.clone(),
                                        |at| elapsed(at, None),
                                    ),
                                ),
                        )
                        .child(crate::icon::stroke(CHEVRON, theme().text_muted, 11., 1.8))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.capture(window, cx);
                            this.execute(Command::Workers, window, cx);
                        }))
                }))
                .when(data.inbox > 0, |list| {
                    list.child(
                        row("activity-inbox")
                            .cursor_pointer()
                            .hover(|row| row.bg(theme().hover))
                            .child(crate::icon::stroke(INBOX, theme().danger, 14., 1.7))
                            .child(ellipsis("Needs you").text_color(theme().text_secondary))
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_size(px(12.5))
                                    .text_color(theme().text_muted)
                                    .child(data.inbox.to_string()),
                            )
                            .child(crate::icon::stroke(CHEVRON, theme().text_muted, 11., 1.8))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.capture(window, cx);
                                super::right_panel::open(this, window, cx);
                            })),
                    )
                }),
        )
}

fn branch(data: &Data, cx: &mut Context<Shell>) -> impl IntoElement {
    let pr = data.pull_request.as_ref();
    let summary = match (pr, data.ahead, data.behind) {
        (Some(_), ..) => "1 pull request".to_string(),
        (None, 0, 0) => "Up to date".to_string(),
        (None, ahead, 0) => format!("{ahead} ahead"),
        (None, 0, behind) => format!("{behind} behind"),
        (None, ahead, behind) => format!("{ahead} ahead · {behind} behind"),
    };
    div()
        .child(title(
            if pr.is_some() {
                "GitHub checkout"
            } else {
                "Branch"
            },
            summary,
        ))
        .child(
            row("activity-branch-repo")
                .mt(px(4.))
                .child(crate::icon::stroke(REPO, theme().text_muted, 13., 1.7))
                .child(
                    ellipsis(
                        data.repo
                            .clone()
                            .unwrap_or_else(|| "This repository".into()),
                    )
                    .font_weight(gpui::FontWeight::MEDIUM),
                )
                .child(
                    div()
                        .flex()
                        .flex_shrink_0()
                        .max_w(px(150.))
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(12.))
                        .text_color(theme().text_muted)
                        .child(crate::icon::stroke(BRANCH, theme().text_muted, 11., 1.7))
                        .child(ellipsis(data.branch.clone().unwrap_or_default()))
                        .child(crate::icon::stroke(OUT, theme().text_muted, 10., 1.7)),
                ),
        )
        .when_some(pr.cloned(), |card, pr| {
            let (label, color) = match (pr.state.as_str(), pr.draft) {
                ("merged", _) => ("Merged", crate::theme::pull_merged()),
                (_, true) => ("Draft", theme().text_muted),
                ("closed", _) => ("Closed", theme().danger),
                _ => ("Open", theme().success),
            };
            let url = pr.url.clone();
            card.child(
                div()
                    .id("activity-pull-request")
                    .debug_selector(|| "activity-pull-request".into())
                    .mt(px(4.))
                    .p(px(10.))
                    .h(px(90.))
                    .flex()
                    .flex_col()
                    .justify_between()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(theme().border)
                    .cursor_pointer()
                    .hover(|card| card.bg(theme().hover))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .px(px(6.))
                                    .h(px(18.))
                                    .rounded(px(5.))
                                    .bg(gpui::Rgba { a: 0.14, ..color })
                                    .text_color(color)
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .child(crate::icon::stroke(PULL, color, 11., 1.8))
                                    .child(label),
                            )
                            .child(
                                ellipsis(format!(
                                    "{} #{}",
                                    data.repo.clone().unwrap_or_default(),
                                    pr.number
                                ))
                                .text_color(theme().text_muted),
                            )
                            .when_some(pr.updated.as_deref().and_then(age), |row, age| {
                                row.child(
                                    div()
                                        .flex_shrink_0()
                                        .text_color(theme().text_muted)
                                        .child(age),
                                )
                            }),
                    )
                    .child(ellipsis(pr.title.clone()).font_weight(gpui::FontWeight::MEDIUM))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .when_some(pr.author.clone(), |row, author| {
                                row.child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .child(
                                            div()
                                                .size(px(14.))
                                                .rounded_full()
                                                .bg(theme().text_faint),
                                        )
                                        .child(author),
                                )
                            })
                            .when_some(pr.comments, |row, n| {
                                row.child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(3.))
                                        .child(crate::icon::stroke(
                                            COMMENT,
                                            theme().text_muted,
                                            11.,
                                            1.7,
                                        ))
                                        .child(n.to_string()),
                                )
                            })
                            .when_some(pr.checks.clone(), |row, checks| {
                                let color = match checks.as_str() {
                                    "success" => theme().success,
                                    "failure" => theme().danger,
                                    _ => theme().warning,
                                };
                                row.child(div().size(px(8.)).rounded_full().bg(color))
                            })
                            .child(div().flex_1())
                            .child(totals(pr.additions, pr.deletions))
                            .when_some(pr.files, |row, n| row.child(format!("{n} files"))),
                    )
                    .on_click(cx.listener(move |_, _, _, cx| {
                        if !url.is_empty() {
                            cx.open_url(&url);
                        }
                    })),
            )
        })
        .child(
            div()
                .pt(px(4.))
                .child(
                    row("activity-incoming")
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .text_color(theme().text_secondary)
                        .child(crate::icon::stroke(REFRESH, theme().text_muted, 13., 1.7))
                        .child(ellipsis(if data.behind > 0 {
                            format!("Review incoming updates · {}", data.behind)
                        } else {
                            "Review incoming updates".into()
                        }))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.capture(window, cx);
                            this.open_registered("Pull requests", window, cx);
                        })),
                )
                .child(
                    row("activity-publish")
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .text_color(theme().text_secondary)
                        .child(crate::icon::stroke(PULL, theme().text_muted, 13., 1.7))
                        .child(ellipsis("Review changes to publish"))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.capture(window, cx);
                            super::right_panel::open_review(this, window, cx);
                        })),
                ),
        )
        .when(pr.is_none(), |card| card.child(worktrees(data, cx)))
}

fn worktrees(data: &Data, cx: &mut Context<Shell>) -> impl IntoElement {
    div().children(
        data.worktrees
            .iter()
            .take(4)
            .enumerate()
            .map(|(index, tree)| {
                let root = tree.path.clone();
                row(SharedString::from(format!("activity-worktree-{index}")))
                    .cursor_pointer()
                    .hover(|row| row.bg(theme().hover))
                    .child(crate::icon::stroke(
                        BRANCH,
                        if tree.current {
                            theme().accent
                        } else {
                            theme().text_muted
                        },
                        13.,
                        1.7,
                    ))
                    .child(
                        ellipsis(tree.branch.clone().unwrap_or_else(|| mono(&tree.path)))
                            .text_color(theme().text_secondary),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .max_w(px(130.))
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .child(mono(&tree.path)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.capture(window, cx);
                        super::right_panel::open_files(this, Some(root.clone()), window, cx);
                    }))
            }),
    )
}

fn files(data: &Data, cx: &mut Context<Shell>) -> impl IntoElement {
    let path = data.path.clone().unwrap_or_default();
    div().child(title("Files", mono(&path))).child(
        div()
            .pt(px(6.))
            .child(
                row("activity-files-browse")
                    .cursor_pointer()
                    .hover(|row| row.bg(theme().hover))
                    .child(crate::icon::stroke(FOLDER, theme().text_muted, 14., 1.7))
                    .child(ellipsis("Browse files").text_color(theme().text_secondary))
                    .child(crate::icon::stroke(CHEVRON, theme().text_muted, 11., 1.8))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        super::right_panel::open_files(this, None, window, cx);
                    })),
            )
            .child(
                row("activity-files-spec")
                    .cursor_pointer()
                    .hover(|row| row.bg(theme().hover))
                    .child(crate::icon::stroke(SPEC, theme().text_muted, 14., 1.7))
                    .child(ellipsis("o8.md").text_color(theme().text_secondary))
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .child("Notes and instructions"),
                    )
                    .child(crate::icon::stroke(CHEVRON, theme().text_muted, 11., 1.8))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        super::right_panel::open_spec(this, window, cx);
                    })),
            )
            .child(worktrees(data, cx)),
    )
}

fn ports(data: &Data, cx: &mut Context<Shell>) -> impl IntoElement {
    let count = data.ports.len();
    div()
        .child(title("Ports", format!("{count} running")))
        .child(
            div()
                .pt(px(6.))
                .children(data.ports.iter().map(|(port, label)| {
                    let url = format!("http://localhost:{port}");
                    row(SharedString::from(format!("activity-port-{port}")))
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .child(
                            div()
                                .size(px(7.))
                                .mx(px(3.5))
                                .rounded_full()
                                .bg(theme().success),
                        )
                        .child(ellipsis(label.clone()).text_color(theme().text_secondary))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(12.))
                                .font_family(theme().font_mono)
                                .text_color(theme().text_muted)
                                .child(format!(":{port}")),
                        )
                        .child(crate::icon::stroke(OUT, theme().text_muted, 11., 1.7))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.capture(window, cx);
                            super::right_panel::open_browser(this, url.clone(), window, cx);
                        }))
                })),
        )
}

// Lucide-style 24px strokes.
const ACTIVITY: &str = "M22 12h-4l-3 9L9 3l-3 9H2";
const PLAN: &str =
    "M3 5l1.5 1.5L7 4 M3 12l1.5 1.5L7 11 M3 19l1.5 1.5L7 18 M11 6h10 M11 13h10 M11 20h10";
const CHANGES: &str = "M7 3v8 M3 7h8 M14 17h7 M17 4L7 20";
const TASKS: &str = "M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4Z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z";
const BRANCH: &str = "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9";
const PULL: &str = "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M6 9v12 M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7";
const FOLDER: &str =
    "M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z";
const PORTS: &str = "M12 22v-5 M9 8V2 M15 8V2 M18 8v5a6 6 0 0 1-12 0V8Z";
const REPO: &str = "M4 19.5V5a2 2 0 0 1 2-2h14v14H6.5a2.5 2.5 0 0 0 0 5H20 M8 7h8";
const OUT: &str = "M7 17L17 7 M8 7h9v9";
const CHEVRON: &str = "M9 6l6 6-6 6";
const CHECK: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M8 12l3 3 5-6";
const CIRCLE: &str = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z";
const SPINNER: &str = "M12 3a9 9 0 0 1 9 9 M21 12a9 9 0 0 1-2.6 6.4 M15.5 20.3a9 9 0 0 1-7 0 M5.6 18.4A9 9 0 0 1 3 12 M3 12a9 9 0 0 1 2.6-6.4 M8.5 3.7a9 9 0 0 1 3.5-.7";
const REFRESH: &str =
    "M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M3 21v-5h5";
const COMMENT: &str = "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z";
const INBOX: &str = "M5 4h14l3 9v7H2v-7l3-9Z M2 13h6l2 3h4l2-3h6";
const SPEC: &str = "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5 M14 3l5 5v3 M8 9h6 M8 13h4 M18.4 13.6a1.4 1.4 0 0 1 2 2L16 20l-3 1 1-3Z";
