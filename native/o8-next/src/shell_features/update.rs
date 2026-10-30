use super::*;
use gpui::SharedString;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
// Updates: the rail's Update control and its panel (RailUpdateControl.tsx).
// o8 next is the app window, so it reads the update state from
// /api/panel/update/apply (GET) and asks the native updater to install
// through the same route (POST), which the classic update card used.
//
// The button's checking, downloading and restart states and the Tools
// section's "Update all" follow T3 Code (MIT, Copyright (c) 2026 T3 Tools
// Inc.): https://github.com/pingdotgg/t3code
// apps/web/src/components/sidebar/DesktopUpdateStatusIcon.tsx and
// apps/web/src/components/ProviderUpdatesAction.tsx at
// 5b4f2aa1532730d4dd51d2cb48a57ff74a0f54eb.
struct Update;
register_shell_feature!(Update);
impl ShellFeature for Update {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 70,
            run: |s, _, _, cx| check(s, cx),
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 10,
            dispatch: |s, event, window, cx| {
                if event.keystroke.key == "escape"
                    && s.features.read::<State>().is_some_and(|state| state.open)
                {
                    close(s, cx);
                    s.restore_focus(window, cx);
                    return KeyResult::Handled;
                }
                KeyResult::Unhandled
            },
        }]
    }
    fn rail(&self) -> &'static [RailItem] {
        &[RailItem {
            order: 10,
            render: |s, window, cx| Some(control(s, window, cx)),
        }]
    }
}

const PANEL_W: f32 = 340.;

#[derive(Default)]
struct State {
    /// The version a completed updater check found, ready to install.
    pending: Option<String>,
    /// The installed version, when the updater reported it.
    current: Option<String>,
    checked: Option<Instant>,
    /// An explicit check is running.
    checking: bool,
    /// The apply request is in flight.
    applying: bool,
    /// Work is live; the next apply forces the restart.
    busy: bool,
    blockers: Option<Blockers>,
    /// The native updater's progress after an accepted apply.
    phase: Option<Phase>,
    progress: Option<Progress>,
    status: Option<String>,
    error: Option<String>,
    notes: Option<Notes>,
    notes_for: Option<String>,
    notes_failed: bool,
    all_notes: bool,
    tools: Vec<Tool>,
    tools_open: bool,
    tools_checking: bool,
    /// Streamed discovery: tools checked of the total, while a check runs.
    discovery: Option<(usize, usize)>,
    /// The last check finished its report.
    tools_checked: bool,
    tools_error: bool,
    tool_busy: Option<String>,
    /// "Update all" is running, and what the last run reported.
    tools_all: bool,
    tools_status: Option<String>,
    open: bool,
    pinned: bool,
    /// When a hover opened the panel; the panel slides in from there.
    opened: Option<Instant>,
    /// Bumped on every open and leave, so a stale close timer does nothing.
    leave: u64,
    /// The update route reported `currentVersion` itself.
    reported: bool,
    /// The identity route's version is current. False at start, after a
    /// reconnect and whenever the panel opens, so a restarted server's new
    /// version replaces the one read before.
    identity_fresh: bool,
    /// The server connection as the last tick saw it.
    connected: bool,
    /// When the update state first read "never checked". The desktop updater
    /// checks at launch, so a later read that still says so means none is
    /// attached.
    never_since: Option<Instant>,
    /// No desktop updater answers this server (`o8 serve` without the app).
    no_updater: bool,
}

/// How long a server may read "never checked" before o8 next stops asking;
/// shorter than the minute between state reads, so the second read decides.
const NO_UPDATER_AFTER: Duration = Duration::from_secs(30);
const NO_UPDATER: &str =
    "Update checks need the o8 app. This window is connected to the o8 server without it.";

/// The installed app's server launched this window, so its desktop updater
/// serves this server however long its first check takes.
fn app_parent() -> bool {
    std::env::var("O8_NEXT_PARENT_PIPE").as_deref() == Ok("1")
}

/// The version a completed updater check found, or `None` when nothing waits.
fn pending(body: &Value) -> Option<String> {
    (body["state"]["updatePending"] == true)
        .then(|| body["state"]["version"].as_str().unwrap_or("").to_string())
}

/// The native updater's progress, from `state.autoApply`.
#[derive(Clone, Debug, PartialEq)]
enum Phase {
    Installing,
    Restarting,
    Failed(String),
}

fn phase(body: &Value) -> Option<Phase> {
    let apply = &body["state"]["autoApply"];
    match apply["phase"].as_str()? {
        "installing" => Some(Phase::Installing),
        "restarting" => Some(Phase::Restarting),
        "failed" => Some(Phase::Failed(
            apply["error"]
                .as_str()
                .unwrap_or("the installer stopped")
                .to_string(),
        )),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Progress {
    stage: String,
    received: u64,
    total: Option<u64>,
}

/// Download progress the native updater publishes as `state.autoApply.progress`;
/// without it the phase alone names the step.
fn progress(body: &Value) -> Option<Progress> {
    let raw = &body["state"]["autoApply"]["progress"];
    if let Some(stage) = raw["stage"].as_str() {
        return Some(Progress {
            stage: stage.to_string(),
            received: raw["receivedBytes"].as_u64().unwrap_or(0),
            total: raw["totalBytes"].as_u64().filter(|total| *total > 0),
        });
    }
    let stage = match phase(body)? {
        Phase::Installing => "installing",
        Phase::Restarting => "restarting",
        Phase::Failed(_) => return None,
    };
    Some(Progress {
        stage: stage.into(),
        received: 0,
        total: None,
    })
}

/// describeUpdateProgress: the label and the bar's fill, `None` while unknown.
fn describe(progress: &Progress) -> (String, Option<f32>) {
    let megabytes = |bytes: u64| {
        let value = bytes as f64 / 1_048_576.;
        if bytes < 10 * 1_048_576 {
            format!("{value:.1}")
        } else {
            format!("{value:.0}")
        }
    };
    match progress.stage.as_str() {
        "installing" => ("Installing o8…".into(), Some(1.)),
        "restarting" => ("Restarting o8…".into(), Some(1.)),
        _ => match progress.total {
            Some(total) => {
                let fraction = (progress.received as f32 / total as f32).min(1.);
                (
                    format!(
                        "Downloading {} of {} MB ({}%)",
                        megabytes(progress.received),
                        megabytes(total),
                        (fraction * 100.).round()
                    ),
                    Some(fraction),
                )
            }
            None if progress.received > 0 => (
                format!("Downloading {} MB…", megabytes(progress.received)),
                None,
            ),
            None => ("Starting download…".into(), None),
        },
    }
}

/// What a restart would wait for, from the server's idle window.
#[derive(Clone, Debug, Default, PartialEq)]
struct Blockers {
    live: Vec<String>,
    parked: Vec<String>,
}

/// describeUpdateBlockers in update-card-view.ts.
fn blockers(idle: &Value) -> Blockers {
    let name = |value: &Value, fallback: &str| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    let list = |value: &Value| value.as_array().cloned().unwrap_or_default();
    let parked_lanes = list(&idle["parkedLanes"]);
    let parked_statuses: Vec<&str> = parked_lanes
        .iter()
        .filter_map(|lane| lane["status"].as_str())
        .collect();
    let active = &idle["active"];
    let mut live = vec![];
    for lane in list(&active["lanes"]) {
        let status = lane["status"].as_str().unwrap_or("active");
        if lane["processLive"] == true || !parked_statuses.contains(&status) {
            live.push(format!(
                "{} ({})",
                name(&lane["label"], "Task"),
                status.replace('_', " ")
            ));
        }
    }
    for session in list(&active["terminalSessions"]) {
        live.push(format!("Terminal {}", name(&session["name"], "session")));
    }
    for run in list(&active["managedRuns"]) {
        live.push(format!("Run: {}", name(&run["command"], "command")));
    }
    for session in list(&active["ownedSessions"]) {
        live.push(
            format!("Agent session {}", name(&session["surfaceId"], ""))
                .trim()
                .to_string(),
        );
    }
    for work in list(&active["workLaunches"]) {
        live.push(name(&work["label"], "Starting process"));
    }
    for job in list(&active["cloudJobs"]) {
        live.push(
            format!("Cloud job {}", name(&job["id"], ""))
                .trim()
                .to_string(),
        );
    }
    if active["restartPending"] == true {
        live.push("Another app restart is already reserved".into());
    }
    for installer in list(&active["cliInstallers"]) {
        let runtime = name(&installer["runtime"], "your tool");
        live.push(match installer["state"].as_str() {
            Some("active") => format!("CLI update for {runtime} is running"),
            Some("interrupted") => format!(
                "CLI update for {runtime} was interrupted; verify the tool and update receipt before retrying restart"
            ),
            _ => format!(
                "CLI update for {runtime} has unconfirmed ownership; verify the tool and update receipt before retrying restart"
            ),
        });
    }
    for item in list(&idle["unavailable"]) {
        live.push(match item.as_str().unwrap_or("") {
            "terminal-sessions" => "Terminal list unavailable".into(),
            "cli-update-ownership" => {
                "CLI update ownership unavailable; check its update receipt before restarting"
                    .into()
            }
            other => format!("Check unavailable: {other}"),
        });
    }
    let parked = parked_lanes
        .iter()
        .map(|lane| {
            let status = lane["status"].as_str().unwrap_or("parked");
            let label = match status {
                "reviewing" => "waiting for review".to_string(),
                "awaiting_input" => "waiting for input".into(),
                "awaiting_orchestrator" => "waiting for the lead".into(),
                "awaiting_human" => "waiting for you".into(),
                "paused" => "paused".into(),
                "idle" => "idle".into(),
                "recovering" => "stopped, can retry".into(),
                other => other.replace('_', " "),
            };
            format!("{} ({label})", name(&lane["label"], "Task"))
        })
        .collect();
    Blockers { live, parked }
}

/// updateRestartLabel: live work other than a CLI update or another restart
/// needs an explicit override.
fn restart_label(blockers: &Blockers) -> &'static str {
    if !blockers.live.is_empty()
        && !blockers
            .live
            .iter()
            .any(|item| item.starts_with("CLI update") || item.starts_with("Another app restart"))
    {
        "Restart anyway"
    } else {
        "Restart now"
    }
}

/// What the server's answer to an apply request means for the shell.
#[derive(Debug, PartialEq)]
enum Outcome {
    Current,
    Restarting,
    /// Work is live; the server restarts only when the request forces it.
    Busy,
    Failed(String),
}

fn outcome(body: &Value) -> Outcome {
    if body["ok"] == true {
        return if body["result"]["code"] == "already_current" {
            Outcome::Current
        } else {
            Outcome::Restarting
        };
    }
    if body["error"]["code"] == "update_apply_busy" {
        return Outcome::Busy;
    }
    Outcome::Failed(
        body["error"]["message"]
            .as_str()
            .unwrap_or("The update could not start.")
            .to_string(),
    )
}

/// An updater error that reads like a dropped request gets RailUpdateControl's plain wording.
fn error_text(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("abort")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("failed to fetch")
        || lower.contains("could not reach")
    {
        "Update checks couldn’t finish. Try again.".into()
    } else {
        error.to_string()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Notes {
    title_changelog: bool,
    published: Option<String>,
    overview: Option<String>,
    entries: Vec<String>,
    summary: String,
    url: String,
}

/// Conventional-commit prefixes never reach the reader.
fn strip_prefix(text: &str) -> String {
    let trimmed = text.trim();
    for kind in ["feat", "fix", "refactor", "perf", "chore", "docs", "style"] {
        let Some(rest) = trimmed
            .get(..kind.len())
            .filter(|head| head.eq_ignore_ascii_case(kind))
            .map(|_| &trimmed[kind.len()..])
        else {
            continue;
        };
        let rest = match rest.strip_prefix('(') {
            Some(scoped) => match scoped.find(')') {
                Some(end) => &scoped[end + 1..],
                None => continue,
            },
            None => rest,
        };
        if let Some(body) = rest.strip_prefix(':') {
            return body.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn notes(body: &Value) -> Option<Notes> {
    let entries: Vec<String> = body["entries"]
        .as_array()?
        .iter()
        .filter_map(|entry| entry["text"].as_str().map(strip_prefix))
        .collect();
    let overview = body["overview"]
        .as_str()
        .map(str::to_string)
        .filter(|overview| {
            !entries.is_empty()
                && entries.first().map(|first| first.to_lowercase())
                    != Some(strip_prefix(overview).to_lowercase())
        });
    Some(Notes {
        title_changelog: body["source"] == "changelog",
        published: body["publishedAt"]
            .as_str()
            .map(|date| date.chars().take(10).collect()),
        overview,
        entries,
        summary: body["summary"].as_str().unwrap_or("").to_string(),
        url: body["releaseUrl"]
            .as_str()
            .unwrap_or("https://github.com/hurttlocker/o8-releases/releases")
            .to_string(),
    })
}

#[derive(Clone, Debug, PartialEq)]
struct Tool {
    runtime: String,
    label: String,
    installed: Option<String>,
    latest: Option<String>,
    status: String,
}

fn tool(tool: &Value) -> Option<Tool> {
    Some(Tool {
        runtime: tool["runtimeId"].as_str()?.to_string(),
        label: tool["label"].as_str().unwrap_or("CLI").to_string(),
        installed: tool["installedVersion"].as_str().map(String::from),
        latest: tool["latestVersion"].as_str().map(String::from),
        status: tool["status"].as_str().unwrap_or("unknown").to_string(),
    })
}

fn tools(body: &Value) -> Vec<Tool> {
    body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|tool| tool["status"] != "not-installed")
        .filter_map(tool)
        .collect()
}

/// One event of the streamed tool discovery (readCliDiscoveryResponse in
/// src/lib/app-update/cli-discovery-response.ts).
#[derive(Debug, PartialEq)]
enum Discovery {
    /// Tools checked of the total.
    Progress(usize, usize),
    /// A tool finished its probe, with the count so far.
    Tool(Tool, Option<(usize, usize)>),
    /// The final report.
    Done(Vec<Tool>),
    Failed,
}

/// Parses one `event:`/`data:` frame; other events and bad data yield `None`.
fn discovery(frame: &str) -> Option<Discovery> {
    let mut event = "";
    let mut data = Vec::new();
    for line in frame.lines() {
        if let Some(name) = line.strip_prefix("event:") {
            event = name.trim();
        } else if let Some(line) = line.strip_prefix("data:") {
            data.push(line.trim_start());
        }
    }
    let body = serde_json::from_str::<Value>(&data.join("\n")).ok()?;
    let count = Option::zip(
        body["completed"].as_u64().map(|count| count as usize),
        body["total"].as_u64().map(|count| count as usize),
    );
    match event {
        "progress" => count.map(|(completed, total)| Discovery::Progress(completed, total)),
        "tool" => tool(&body["tool"]).map(|tool| Discovery::Tool(tool, count)),
        "result" if body["tools"].is_array() => Some(Discovery::Done(tools(&body))),
        "result" | "error" => Some(Discovery::Failed),
        _ => None,
    }
}

/// Folds one discovery event into the panel. Streamed rows replace their old
/// row or join the end; the final report keeps that arrival order.
fn discovered(state: &mut State, event: Discovery) {
    match event {
        Discovery::Progress(completed, total) => state.discovery = Some((completed, total)),
        Discovery::Tool(tool, count) => {
            if count.is_some() {
                state.discovery = count;
            }
            let at = state
                .tools
                .iter()
                .position(|row| row.runtime == tool.runtime);
            match (at, tool.status == "not-installed") {
                (Some(at), true) => {
                    state.tools.remove(at);
                }
                (Some(at), false) => state.tools[at] = tool,
                (None, true) => {}
                (None, false) => state.tools.push(tool),
            }
        }
        Discovery::Done(mut tools) => {
            let order = |tool: &Tool| {
                state
                    .tools
                    .iter()
                    .position(|row| row.runtime == tool.runtime)
                    .unwrap_or(usize::MAX)
            };
            tools.sort_by_key(order);
            state.tools = tools;
            state.tools_checked = true;
        }
        Discovery::Failed => state.tools_error = true,
    }
}

/// GET /api/setup/cli-updates as an event stream, each event sent on as it
/// arrives. A server that answers with JSON sends one final report.
fn stream_tools(
    client: &crate::client::Client,
    refresh: bool,
    events: &async_channel::Sender<Discovery>,
) -> Result<(), ()> {
    use std::io::BufRead;
    let mut url = client.url("/api/setup/cli-updates").map_err(drop)?;
    if refresh {
        url.query_pairs_mut().append_pair("refresh", "1");
    }
    // Cold version probes can take minutes; classic bounds the whole check at five.
    let response = client
        .request("GET", &url)
        .set("Accept", "text/event-stream")
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(drop)?;
    if response.content_type() != "text/event-stream" {
        let body = crate::client::Client::read::<Value>(response).map_err(drop)?;
        let event = if body["tools"].is_array() {
            Discovery::Done(tools(&body))
        } else {
            Discovery::Failed
        };
        let _ = events.send_blocking(event);
        return Ok(());
    }
    let mut frame = String::new();
    for line in std::io::BufReader::new(response.into_reader()).lines() {
        let line = line.map_err(drop)?;
        let line = line.trim_end_matches('\r');
        if !line.is_empty() {
            frame.push_str(line);
            frame.push('\n');
            continue;
        }
        if let Some(event) = discovery(&std::mem::take(&mut frame)) {
            let last = matches!(event, Discovery::Done(_) | Discovery::Failed);
            // A closed panel state drops the receiver; stop reading.
            if events.send_blocking(event).is_err() || last {
                return Ok(());
            }
        }
    }
    // The stream ended before its report.
    Err(())
}

/// CFBundleShortVersionString from an Info.plist.
fn plist_version(plist: &str) -> Option<String> {
    let rest = &plist[plist.find("<key>CFBundleShortVersionString</key>")?..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = start + rest[start..].find("</string>")?;
    Some(rest[start..end].trim().to_string()).filter(|version| !version.is_empty())
}

/// The installed o8 version, read from the app bundle o8 next ships inside
/// (o8.app/Contents/MacOS/o8-next). A dev build outside a bundle has none.
fn bundle_version() -> Option<String> {
    static VERSION: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    VERSION
        .get_or_init(|| {
            let exe = std::env::current_exe().ok()?;
            let plist = exe.parent()?.parent()?.join("Info.plist");
            plist_version(&std::fs::read_to_string(plist).ok()?)
        })
        .clone()
}

/// Applies a GET of the update route to the state.
fn read(state: &mut State, body: &Value) {
    let pending = pending(body);
    if state.pending != pending {
        state.busy = false;
        state.blockers = None;
    }
    state.pending = pending;
    let info = &body["state"]["info"];
    let reported = body["currentVersion"]
        .as_str()
        .or(info["currentVersion"].as_str())
        .or(info["current_version"].as_str());
    state.reported = reported.is_some();
    if let Some(current) = reported {
        state.current = Some(current.to_string());
    } else if state.current.is_none() {
        state.current = bundle_version();
    }
    state.phase = phase(body);
    state.progress = progress(body);
    if body["state"]["autoApply"]["phase"] == "waiting" {
        let waiting = &body["state"]["autoApply"]["blockers"];
        let as_list = |value: &Value| {
            value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item.as_str().map(String::from))
                .collect::<Vec<_>>()
        };
        state.blockers = Some(Blockers {
            live: as_list(&waiting["live"]),
            parked: as_list(&waiting["parked"]),
        });
    }
    if body["state"]["check"]["outcome"] == "never" && !app_parent() {
        let since = *state.never_since.get_or_insert_with(Instant::now);
        state.no_updater |= since.elapsed() >= NO_UPDATER_AFTER;
    } else {
        state.never_since = None;
        state.no_updater = false;
    }
    if let Some(Phase::Failed(error)) = &state.phase {
        state.error = Some(format!("The update failed: {error}"));
    } else if body["state"]["check"]["outcome"] == "failed" {
        state.error = body["state"]["check"]["error"].as_str().map(error_text);
    }
}

/// Reads the update state about once a minute, and every second while the
/// native updater installs.
fn check(s: &mut Shell, cx: &mut Context<Shell>) {
    let connected = s.connected;
    let state = s.features.get::<State>();
    if connected && !state.connected {
        state.identity_fresh = false;
    }
    state.connected = connected;
    if connected && !state.reported && !state.identity_fresh {
        state.identity_fresh = true;
        read_identity(s, cx);
    }
    let state = s.features.get::<State>();
    let every = if state.phase.is_some() || state.applying {
        1
    } else {
        60
    };
    if state.checking
        || state
            .checked
            .is_some_and(|at| at.elapsed().as_secs() < every)
    {
        return;
    }
    state.checked = Some(Instant::now());
    let client = s.client.clone();
    let task = cx
        .background_executor()
        .spawn(async move { client.get::<Value>("/api/panel/update/apply", &[]) });
    cx.spawn(async move |this, cx| {
        let Ok(body) = task.await else { return };
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            read(state, &body);
            let version = state.pending.clone();
            if state.open && state.notes_for != version.clone().or(Some("latest".into())) {
                load_notes(this, cx);
            }
            cx.notify();
        });
    })
    .detach();
}

/// Servers before `currentVersion` report their version on the identity route.
fn read_identity(s: &mut Shell, cx: &mut Context<Shell>) {
    let client = s.client.clone();
    let task = cx
        .background_executor()
        .spawn(async move { client.get::<Value>("/api/setup/identity", &[]) });
    cx.spawn(async move |this, cx| {
        let Ok(body) = task.await else { return };
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            if !state.reported
                && let Some(version) = body["version"].as_str().filter(|v| !v.is_empty())
            {
                state.current = Some(version.to_string());
                cx.notify();
            }
        });
    })
    .detach();
}

/// A fresh updater check, as the control's click and the refresh button run it.
fn check_now(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.checking || state.applying {
        return;
    }
    state.error = None;
    state.status = None;
    // Nothing would answer; say so instead of waiting out the server.
    if state.no_updater {
        toasts::info("Update checks need the o8 app.", cx);
        cx.notify();
        return;
    }
    state.checking = true;
    s.notice = "Checking o8…".into();
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let url = client
            .url("/api/panel/update/apply")
            .map_err(|_| "Invalid route".to_string())?;
        // The server waits up to 25 seconds for the native check to finish.
        let request = client
            .request("POST", &url)
            .timeout(Duration::from_secs(40));
        match request.send_json(json!({ "checkOnly": true })) {
            Ok(response) => crate::client::Client::read::<Value>(response),
            Err(ureq::Error::Status(_, response)) => crate::client::Client::read::<Value>(response),
            Err(_) => Err("Could not reach the server".to_string()),
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            state.checking = false;
            state.checked = Some(Instant::now());
            match result {
                Ok(body) => {
                    read(state, &body);
                    // The server waited for a check no updater ever ran.
                    let headless = body["error"]["code"] == "update_check_unavailable"
                        && body["state"]["check"]["outcome"] == "never"
                        && !app_parent();
                    state.no_updater |= headless;
                    let failed = body["ok"] != true && !headless;
                    if failed {
                        let message = body["error"]["message"]
                            .as_str()
                            .unwrap_or("The o8 update check could not finish. Try again.");
                        state.error = Some(error_text(message));
                    }
                    let ready = state.pending.is_some();
                    let message = if headless {
                        "Update checks need the o8 app."
                    } else if failed {
                        "The o8 update check could not finish. Try again."
                    } else if ready {
                        "o8 update is ready."
                    } else {
                        "o8 is up to date."
                    };
                    if this.notice == "Checking o8…" {
                        this.notice.clear();
                    }
                    if failed {
                        toasts::error(message, cx);
                    } else {
                        toasts::info(message, cx);
                    }
                }
                Err(error) => {
                    state.error = Some(error_text(&error));
                    if this.notice == "Checking o8…" {
                        this.notice.clear();
                    }
                    toasts::error(
                        format!("Update checks could not finish. Try again.\n{error}"),
                        cx,
                    );
                }
            }
            load_notes(this, cx);
            cx.notify();
        });
    })
    .detach();
}

fn apply(s: &mut Shell, force: bool, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.applying {
        return;
    }
    let force = force || state.busy;
    state.applying = true;
    state.pinned = true;
    state.error = None;
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let url = client
            .url("/api/panel/update/apply")
            .map_err(|_| "Invalid route".to_string())?;
        // The server may first wait up to 25 seconds for a fresh updater check.
        let request = client
            .request("POST", &url)
            .timeout(Duration::from_secs(40));
        match request.send_json(json!({ "force": force })) {
            Ok(response) => crate::client::Client::read::<Value>(response),
            // A refusal (busy, check failed) carries its reason in the body.
            Err(ureq::Error::Status(_, response)) => crate::client::Client::read::<Value>(response),
            Err(_) => Err("Could not reach the server".to_string()),
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            state.applying = false;
            state.busy = false;
            match result {
                Ok(body) => match outcome(&body) {
                    Outcome::Current => {
                        state.pending = None;
                        state.blockers = None;
                        state.status = Some("o8 is up to date.".into());
                    }
                    // The native updater installs and restarts; the panel
                    // follows its phase from the next reads.
                    Outcome::Restarting => {
                        state.blockers = None;
                        state.phase = Some(Phase::Installing);
                        state.progress = Some(Progress {
                            stage: "downloading".into(),
                            received: 0,
                            total: None,
                        });
                        state.checked = None;
                    }
                    Outcome::Busy => {
                        state.busy = true;
                        state.blockers = Some(blockers(&body["idle"]));
                    }
                    Outcome::Failed(message) => state.error = Some(error_text(&message)),
                },
                Err(error) => state.error = Some(format!("The update could not start: {error}")),
            }
            cx.notify();
        });
    })
    .detach();
}

fn load_notes(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    let version = state.pending.clone().unwrap_or_else(|| "latest".into());
    if state.notes_for.as_deref() == Some(version.as_str()) {
        return;
    }
    state.notes_for = Some(version.clone());
    state.notes = None;
    state.notes_failed = false;
    state.all_notes = false;
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        client.get::<Value>(
            "/api/panel/o8-update-summary",
            &[("version", version.as_str())],
        )
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            match result.ok().as_ref().and_then(notes) {
                Some(notes) => state.notes = Some(notes),
                None => state.notes_failed = true,
            }
            cx.notify();
        });
    })
    .detach();
}

fn load_tools(s: &mut Shell, refresh: bool, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.tools_checking {
        return;
    }
    state.tools_checking = true;
    state.discovery = None;
    state.tools_checked = false;
    state.tools_error = false;
    let client = s.client.clone();
    let (events, received) = async_channel::unbounded();
    let task = cx
        .background_executor()
        .spawn(async move { stream_tools(&client, refresh, &events) });
    cx.spawn(async move |this, cx| {
        while let Ok(event) = received.recv().await {
            let applied = this.update(cx, |this, cx| {
                discovered(this.features.get::<State>(), event);
                cx.notify();
            });
            if applied.is_err() {
                return;
            }
        }
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            state.tools_checking = false;
            state.discovery = None;
            if result.is_err() || !state.tools_checked {
                state.tools_error = true;
            }
            cx.notify();
        });
    })
    .detach();
}

/// POST /api/setup/cli-updates for one runtime; installs can take minutes.
fn post_tool(client: &crate::client::Client, runtime: &str) -> Result<Value, String> {
    let url = client
        .url("/api/setup/cli-updates")
        .map_err(|_| "Invalid route".to_string())?;
    let request = client
        .request("POST", &url)
        .timeout(Duration::from_secs(360));
    match request.send_json(json!({ "runtime": runtime })) {
        Ok(response) => crate::client::Client::read::<Value>(response),
        Err(ureq::Error::Status(_, response)) => crate::client::Client::read::<Value>(response),
        Err(_) => Err("Could not reach the server".to_string()),
    }
}

fn update_tool(s: &mut Shell, runtime: String, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.tool_busy.is_some() || state.tools_all {
        return;
    }
    state.tool_busy = Some(runtime.clone());
    let client = s.client.clone();
    let task = cx
        .background_executor()
        .spawn(async move { post_tool(&client, &runtime) });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            this.features.get::<State>().tool_busy = None;
            if let Ok(body) = &result
                && let Some(error) = body["error"].as_str()
            {
                toasts::error(error.to_string(), cx);
            }
            load_tools(this, true, cx);
        });
    })
    .detach();
}

/// "Update all" (T3 Code's ProviderUpdatesAction): every tool with an update,
/// one after another, then one line saying what happened.
fn update_all(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.tool_busy.is_some() || state.tools_all {
        return;
    }
    let targets: Vec<(String, String)> = state
        .tools
        .iter()
        .filter(|tool| tool.status == "update-available")
        .map(|tool| (tool.runtime.clone(), tool.label.clone()))
        .collect();
    if targets.is_empty() {
        return;
    }
    state.tools_all = true;
    state.tools_status = None;
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        targets
            .into_iter()
            .map(|(runtime, label)| {
                let outcome = match post_tool(&client, &runtime) {
                    Ok(body) => match body["error"].as_str() {
                        Some(error) => Err(error.to_string()),
                        None => Ok(()),
                    },
                    Err(error) => Err(error),
                };
                (label, outcome)
            })
            .collect::<Vec<_>>()
    });
    cx.spawn(async move |this, cx| {
        let results = task.await;
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            state.tools_all = false;
            state.tools_status = Some(update_summary(&results));
            load_tools(this, true, cx);
        });
    })
    .detach();
}

/// What an "Update all" run did, in one line.
fn update_summary(results: &[(String, Result<(), String>)]) -> String {
    let names = |done: Vec<&String>| match done.as_slice() {
        [one] => one.to_string(),
        [first, second] => format!("{first} and {second}"),
        many => format!("{} tools", many.len()),
    };
    let updated: Vec<&String> = results
        .iter()
        .filter(|(_, outcome)| outcome.is_ok())
        .map(|(label, _)| label)
        .collect();
    let failed: Vec<(&String, &String)> = results
        .iter()
        .filter_map(|(label, outcome)| outcome.as_ref().err().map(|error| (label, error)))
        .collect();
    let failure = match failed.as_slice() {
        [] => None,
        [(label, error)] => Some(format!("{label} failed: {error}")),
        many => Some(format!("{} tools failed to update.", many.len())),
    };
    match (updated.is_empty(), failure) {
        (false, None) => format!("Updated {}.", names(updated)),
        (false, Some(failure)) => format!("Updated {}. {failure}", names(updated)),
        (true, Some(failure)) => failure,
        (true, None) => "Nothing to update.".into(),
    }
}

fn show(s: &mut Shell, animate: bool, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.checking {
        return;
    }
    state.leave += 1;
    if !state.open {
        state.open = true;
        state.identity_fresh = false;
        state.opened = animate.then(Instant::now);
        load_notes(s, cx);
    }
    cx.notify();
}

fn close(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    state.open = false;
    state.pinned = false;
    state.leave += 1;
    cx.notify();
}

/// Leaving closes the panel after 180 ms, unless it is pinned or installing.
fn leave(s: &mut Shell, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    state.leave += 1;
    if state.pinned || state.applying || state.phase.is_some() {
        return;
    }
    let generation = state.leave;
    cx.spawn(async move |this, cx| {
        cx.background_executor()
            .timer(Duration::from_millis(180))
            .await;
        let _ = this.update(cx, |this, cx| {
            let state = this.features.get::<State>();
            if state.leave == generation {
                state.open = false;
                cx.notify();
            }
        });
    })
    .detach();
}

/// The panel's slide in, 140 ms from x −5, y +3; (position 0–1, moving).
fn appear(state: &State) -> (f32, bool) {
    match state.opened {
        None => (1., false),
        Some(at) => {
            let t = (at.elapsed().as_secs_f32() / 0.14).min(1.);
            (crate::motion::ease_out(t), t < 1.)
        }
    }
}

/// The clock the checking glyph turns by.
static SPIN: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

/// Download progress drawn around the 32 px circle, clockwise from the top,
/// over a faint full track (DesktopUpdateDownloadingIcon).
fn ring(color: gpui::Rgba, fraction: f32) -> impl IntoElement {
    let track = gpui::Rgba {
        a: color.a * 0.22,
        ..color
    };
    div()
        .absolute()
        .top(px(0.))
        .left(px(0.))
        .size(px(32.))
        .child(
            div()
                .absolute()
                .child(crate::icon::stroke(&arc(1.), track, 32., 1.1)),
        )
        .child(
            div()
                .absolute()
                .child(crate::icon::stroke(&arc(fraction), color, 32., 1.1)),
        )
}

/// An SVG arc on the 24-unit icon grid: radius 10.5 around the centre,
/// starting at the top. Fractions round to whole percents so the rasterised
/// paths stay few.
fn arc(fraction: f32) -> String {
    let fraction = (fraction.clamp(0., 1.) * 100.).round() / 100.;
    if fraction >= 1. {
        return "M12 1.5a10.5 10.5 0 1 1 0 21a10.5 10.5 0 1 1 0-21".into();
    }
    let angle = fraction * std::f32::consts::TAU;
    let (x, y) = (12. + 10.5 * angle.sin(), 12. - 10.5 * angle.cos());
    let large = u8::from(fraction > 0.5);
    format!("M12 1.5A10.5 10.5 0 {large} 1 {x:.2} {y:.2}")
}

fn control(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) -> gpui::AnyElement {
    let state = s.features.get::<State>();
    // Frames are requested while rendering: ticks run outside any view, where
    // GPUI has no current view to schedule them for.
    if state.open && (appear(state).1 || state.applying || state.phase.is_some()) {
        window.request_animation_frame();
    }
    let ready = state.pending.is_some();
    let tools_ready = state
        .tools
        .iter()
        .any(|tool| tool.status == "update-available");
    let busy = state.checking || state.applying;
    let checking = state.checking;
    // T3 Code's DesktopUpdateStatusIcon states over the classic button: a ring
    // while downloading, a restart glyph with a check once installing, and a
    // turning refresh glyph while a check runs.
    let stage = state
        .progress
        .as_ref()
        .map(|progress| progress.stage.clone());
    let restarting = matches!(stage.as_deref(), Some("installing" | "restarting"));
    let downloading = !restarting && (stage.is_some() || (state.applying && state.phase.is_none()));
    let fraction = state
        .progress
        .as_ref()
        .and_then(|progress| describe(progress).1)
        .unwrap_or(0.15);
    let open = state.open;
    if checking || downloading {
        window.request_animation_frame();
    }
    let viewport = f32::from(window.viewport_size().height);
    let panel = open.then(|| panel(s, viewport, cx));
    div()
        .relative()
        .flex_shrink_0()
        .child(
            div()
                .id("rail-update")
                .debug_selector(|| "rail-update".into())
                .size(px(44.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(10.))
                .when(!busy, |button| button.cursor_pointer())
                .hover(|button| button.bg(theme().hover))
                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                    if *hovered {
                        show(this, true, cx);
                    } else {
                        leave(this, cx);
                    }
                }))
                .on_click(cx.listener(|this, _, _, cx| {
                    show(this, false, cx);
                    this.features.get::<State>().pinned = true;
                    check_now(this, cx);
                }))
                .child(
                    div()
                        .relative()
                        .size(px(32.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .when(ready, |circle| circle.bg(crate::theme::update_ready()))
                        .child({
                            let color = if ready {
                                crate::theme::on_accent()
                            } else {
                                theme().text_muted
                            };
                            if restarting {
                                crate::icon::stroke(ROTATE, color, 16., 2.)
                            } else if checking {
                                let turn = SPIN.elapsed().as_secs_f32() / 0.9;
                                crate::icon::stroke(REFRESH, color, 16., 2.).with_transformation(
                                    gpui::Transformation::rotate(gpui::radians(
                                        turn.fract() * std::f32::consts::TAU,
                                    )),
                                )
                            } else {
                                crate::icon::stroke(DOWNLOAD, color, 19., 1.8)
                            }
                        })
                        .when(downloading, |circle| {
                            let color = if ready {
                                crate::theme::on_accent()
                            } else {
                                theme().text
                            };
                            circle.child(ring(color, fraction))
                        })
                        .when(restarting, |circle| {
                            circle.child(
                                div()
                                    .absolute()
                                    .right(px(-2.))
                                    .bottom(px(-2.))
                                    .size(px(13.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .bg(theme().text)
                                    .border_2()
                                    .border_color(theme().background)
                                    .child(crate::icon::stroke(CHECK, theme().background, 8., 3.5)),
                            )
                        })
                        .when(!ready && tools_ready, |circle| {
                            circle.child(
                                div()
                                    .absolute()
                                    .top(px(5.))
                                    .right(px(5.))
                                    .size(px(6.))
                                    .rounded_full()
                                    .bg(crate::theme::update_ready()),
                            )
                        }),
                ),
        )
        .children(panel)
        .into_any_element()
}

fn panel(s: &mut Shell, viewport: f32, cx: &mut Context<Shell>) -> gpui::AnyElement {
    if s.features.get::<State>().current.is_none() {
        s.features.get::<State>().current = bundle_version();
    }
    let state = s.features.get::<State>();
    let (t, _) = appear(state);
    let max_height = (viewport - 24.).clamp(160., 540.);
    let title = if state.pending.is_some() {
        "Updates ready"
    } else {
        "Updates"
    };
    let subline = match (&state.pending, &state.current) {
        (Some(version), Some(current)) if !version.is_empty() => {
            Some(format!("o8 {current} → {version}"))
        }
        (Some(version), _) if !version.is_empty() => Some(format!("o8 {version} available")),
        (None, Some(current)) => Some(format!("o8 {current} installed")),
        _ => None,
    };
    let pending_work = state.applying || state.phase.is_some();
    let line = state
        .error
        .clone()
        .map(|error| (error, true))
        .or_else(|| state.status.clone().map(|status| (status, false)))
        .or_else(|| state.no_updater.then(|| (NO_UPDATER.to_string(), false)));
    let bar = state.progress.as_ref().map(describe);
    let blockers = state.blockers.clone();
    let can_update = state.pending.is_some() && blockers.is_none();
    let installing = state.applying || matches!(state.phase, Some(Phase::Installing));
    let tools_open = state.tools_open;
    let tools_rows = state.tools.clone();
    let tools_checking = state.tools_checking;
    let discovery = state.discovery;
    let tools_checked = state.tools_checked;
    let tools_error = state.tools_error;
    let tool_busy = state.tool_busy.clone();
    let tools_all = state.tools_all;
    let tools_status = state.tools_status.clone();
    let tools_ready = tools_rows
        .iter()
        .any(|tool| tool.status == "update-available");
    let notes = state.notes.clone();
    let notes_failed = state.notes_failed;
    let all_notes = state.all_notes;
    let checking = state.checking;

    let muted = |text: SharedString, size: f32| {
        div()
            .text_size(px(size))
            .line_height(px(size * 1.5))
            .text_color(theme().text_muted)
            .child(text)
    };
    let secondary = |text: String| {
        div()
            .text_size(px(11.5))
            .line_height(px(17.))
            .text_color(theme().text_secondary)
            .child(text)
    };
    let list = |items: &[String]| {
        let shown = items.iter().take(6).cloned().collect::<Vec<_>>();
        let more = items.len().saturating_sub(6);
        div()
            .flex()
            .flex_col()
            .children(shown.into_iter().map(|item| {
                div()
                    .flex()
                    .gap(px(6.))
                    .pl(px(4.))
                    .child("•")
                    .child(div().flex_1().min_w_0().child(item))
            }))
            .when(more > 0, |list| {
                list.child(
                    div()
                        .text_color(theme().text_muted)
                        .child(format!("and {more} more")),
                )
            })
    };
    let button = |id: &'static str, label: String, accent: bool| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .h(px(30.))
            .px(px(12.))
            .flex()
            .items_center()
            .rounded(px(7.))
            .text_size(px(12.))
            .cursor_pointer()
            .when(accent, |button| {
                button
                    .bg(theme().accent)
                    .text_color(crate::theme::on_accent())
            })
            .when(!accent, |button| {
                button.bg(theme().hover).text_color(theme().text)
            })
            .child(label)
    };
    let rule = || div().h(px(1.)).bg(theme().border);

    // A definite width, so notes and blockers wrap inside the scrolling card.
    let body = div()
        .w(px(PANEL_W - 2.))
        .p(px(16.))
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .child(
                            div()
                                .text_size(px(14.))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child(title),
                        )
                        .children(subline.map(|line| muted(line.into(), 11.).mt(px(3.)))),
                )
                .child(
                    div()
                        .id("update-refresh")
                        .debug_selector(|| "update-refresh".into())
                        .size(px(32.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(7.))
                        .bg(theme().hover)
                        .cursor_pointer()
                        .when(checking, |refresh| refresh.opacity(0.5))
                        .child(crate::icon::stroke(REFRESH, theme().text, 14., 1.7))
                        .on_click(cx.listener(|this, _, _, cx| check_now(this, cx))),
                ),
        )
        .children(line.map(|(text, error)| {
            div()
                .text_size(px(11.5))
                .line_height(px(17.))
                .text_color(if error {
                    theme().danger
                } else {
                    theme().text_secondary
                })
                .child(text)
        }))
        .children(bar.map(|(label, fraction)| {
            div()
                .id("update-progress")
                .debug_selector(|| "update-progress".into())
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(secondary(label))
                .child(
                    div()
                        .h(px(4.))
                        .rounded(px(2.))
                        .bg(theme().hover)
                        .overflow_hidden()
                        .child(
                            div()
                                .h_full()
                                .w(gpui::relative(fraction.unwrap_or(0.15)))
                                .bg(theme().accent),
                        ),
                )
        }))
        .children(blockers.map(|blockers| {
            let label = restart_label(&blockers);
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_size(px(11.5))
                .line_height(px(17.))
                .text_color(theme().text_secondary)
                .when(!blockers.live.is_empty(), |section| {
                    section
                        .child("Work to check before restarting:")
                        .child(list(&blockers.live))
                })
                .when(!blockers.parked.is_empty(), |section| {
                    section
                        .child(if blockers.live.is_empty() {
                            "These tasks are waiting and keep their state across a restart:"
                        } else {
                            "Also waiting, and kept across a restart:"
                        })
                        .child(list(&blockers.parked))
                })
                .child(
                    div().child(
                        button("update-restart", label.into(), true)
                            .on_click(cx.listener(|this, _, _, cx| apply(this, true, cx))),
                    ),
                )
        }))
        .when(can_update, |body| {
            body.child(
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(6.))
                    .child(
                        button(
                            "update-install",
                            if installing {
                                "Updating o8…".into()
                            } else {
                                "Update o8".into()
                            },
                            true,
                        )
                        .when(pending_work, |button| button.opacity(0.65))
                        .on_click(cx.listener(|this, _, _, cx| apply(this, false, cx))),
                    )
                    .child(muted("Updates o8 only. Other tools stay under Tools.".into(), 10.5)),
            )
        })
        .child(rule())
        .child(
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .id("update-tools")
                        .debug_selector(|| "update-tools".into())
                        .h(px(30.))
                        .flex()
                        .items_center()
                        .justify_between()
                        .text_size(px(12.))
                        .cursor_pointer()
                        .child(if tools_ready {
                            "Tools · updates available"
                        } else {
                            "Tools"
                        })
                        .child(crate::icon::stroke(
                            if tools_open { CHEVRON_UP } else { CHEVRON },
                            theme().text_secondary,
                            13.,
                            1.8,
                        ))
                        .on_click(cx.listener(|this, _, _, cx| {
                            let state = this.features.get::<State>();
                            state.tools_open = !state.tools_open;
                            if state.tools_open {
                                load_tools(this, false, cx);
                            }
                            cx.notify();
                        })),
                )
                .when(tools_open, |section| {
                    // One size for the section's three small buttons.
                    let small = |button: gpui::Stateful<gpui::Div>| {
                        button
                            .flex_shrink_0()
                            .h(px(26.))
                            .px(px(10.))
                            .text_size(px(11.5))
                    };
                    // One status line beside the buttons; the summary of the
                    // last "Update all" sits under it.
                    let status = if tools_checking {
                        match discovery {
                            Some((completed, total)) => {
                                format!("Checking tools… {completed} of {total} checked")
                            }
                            None => "Checking installed tools…".into(),
                        }
                    } else if tools_error {
                        "CLI checks couldn’t finish. Try again.".into()
                    } else if tools_rows.is_empty() {
                        "No supported CLI installation was found.".into()
                    } else if tools_checked {
                        "Tool discovery complete.".into()
                    } else {
                        String::new()
                    };
                    let fraction = discovery
                        .filter(|(_, total)| *total > 0)
                        .map(|(completed, total)| completed as f32 / total as f32);
                    let rows = tools_rows.into_iter().map(|tool| {
                        let available = tool.status == "update-available";
                        let busy = tool_busy.as_deref() == Some(tool.runtime.as_str())
                            || (tools_all && available);
                        let versions = match (&tool.installed, &tool.latest) {
                            (Some(installed), Some(latest)) if available => {
                                format!("{installed} → {latest}")
                            }
                            (Some(installed), _) => installed.clone(),
                            _ => tool.status.replace('-', " "),
                        };
                        let runtime = tool.runtime.clone();
                        // Every row is the same height, with or without its button.
                        div()
                            .h(px(32.))
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .line_height(px(16.))
                                            .truncate()
                                            .child(tool.label.clone()),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(10.5))
                                            .line_height(px(14.))
                                            .text_color(theme().text_muted)
                                            .truncate()
                                            .child(versions),
                                    ),
                            )
                            .when(available, |row| {
                                row.child(small(
                                    div()
                                        .id(SharedString::from(format!(
                                            "update-tool-{}",
                                            tool.runtime
                                        )))
                                        .flex()
                                        .items_center()
                                        .rounded(px(7.))
                                        .bg(theme().hover)
                                        .text_color(theme().text)
                                        .cursor_pointer()
                                        .child(if busy { "Updating…" } else { "Update" })
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            update_tool(this, runtime.clone(), cx)
                                        })),
                                ))
                            })
                    });
                    section.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(muted(
                                "Update each tool explicitly. Running sessions stay protected."
                                    .into(),
                                11.,
                            ))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .min_h(px(26.))
                                            .flex()
                                            .items_center()
                                            .gap(px(12.))
                                            .child(muted(status.into(), 11.).flex_1().min_w_0())
                                            .child(
                                                div()
                                                    .flex_shrink_0()
                                                    .flex()
                                                    .gap(px(6.))
                                                    .when(tools_ready || tools_all, |actions| {
                                                        actions.child(small(
                                                            button(
                                                                "update-tools-all",
                                                                if tools_all {
                                                                    "Updating…"
                                                                } else {
                                                                    "Update all"
                                                                }
                                                                .into(),
                                                                false,
                                                            )
                                                            .on_click(cx.listener(
                                                                |this, _, _, cx| update_all(this, cx),
                                                            )),
                                                        ))
                                                    })
                                                    .child(small(
                                                        button(
                                                            "update-tools-check",
                                                            if tools_error { "Retry" } else { "Check" }
                                                                .into(),
                                                            false,
                                                        )
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            load_tools(this, true, cx)
                                                        })),
                                                    )),
                                            ),
                                    )
                                    .when(tools_checking, |block| {
                                        block.child(
                                            div()
                                                .id("update-tools-discovery")
                                                .debug_selector(|| "update-tools-discovery".into())
                                                .h(px(3.))
                                                .rounded(px(2.))
                                                .bg(theme().hover)
                                                .overflow_hidden()
                                                .child(
                                                    div()
                                                        .h_full()
                                                        .w(gpui::relative(
                                                            fraction.unwrap_or(0.15).min(1.),
                                                        ))
                                                        .bg(theme().accent),
                                                ),
                                        )
                                    })
                                    .when_some(tools_status, |block, summary| {
                                        block.child(muted(summary.into(), 11.))
                                    }),
                            )
                            .child(div().flex().flex_col().gap(px(8.)).children(rows)),
                    )
                }),
        )
        .child(rule())
        .child({
            let heading = if notes.as_ref().is_some_and(|notes| notes.title_changelog) {
                "Latest published changes"
            } else {
                "What’s changed"
            };
            let url = notes
                .as_ref()
                .map(|notes| notes.url.clone())
                .unwrap_or_else(|| "https://github.com/hurttlocker/o8-releases/releases".into());
            let entries = notes.as_ref().map(|notes| notes.entries.clone()).unwrap_or_default();
            let extra = entries.len().saturating_sub(5);
            let shown = if all_notes {
                entries.clone()
            } else {
                entries.iter().take(5).cloned().collect()
            };
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.5))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(heading),
                )
                .children(
                    notes
                        .as_ref()
                        .filter(|notes| notes.title_changelog)
                        .and_then(|notes| notes.published.clone())
                        .map(|date| muted(format!("Published {date}").into(), 10.5)),
                )
                .children(
                    notes
                        .as_ref()
                        .and_then(|notes| notes.overview.clone())
                        .map(|overview| secondary(overview).text_size(px(12.)).line_height(px(19.))),
                )
                .when(!shown.is_empty(), |section| {
                    section.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(9.))
                            .text_size(px(12.))
                            .line_height(px(19.))
                            .text_color(theme().text_secondary)
                            .children(shown.into_iter().map(|entry| {
                                div()
                                    .flex()
                                    .gap(px(8.))
                                    .child("•")
                                    .child(div().flex_1().min_w_0().child(entry))
                            })),
                    )
                })
                .when(entries.is_empty(), |section| {
                    section.child(muted(
                        if notes_failed {
                            "Published notes are unavailable right now. Open the release history for details.".into()
                        } else if let Some(notes) = &notes {
                            notes.summary.clone().into()
                        } else {
                            "Loading published notes…".into()
                        },
                        12.,
                    ))
                })
                .when(extra > 0, |section| {
                    section.child(
                        div()
                            .id("update-more-notes")
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .cursor_pointer()
                            .child(if all_notes {
                                "Show fewer changes".to_string()
                            } else {
                                format!("{extra} more changes")
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                let state = this.features.get::<State>();
                                state.all_notes = !state.all_notes;
                                cx.notify();
                            })),
                    )
                })
                .child(
                    div()
                        .id("update-release")
                        .debug_selector(|| "update-release".into())
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(11.5))
                        .text_color(theme().text_secondary)
                        .cursor_pointer()
                        .hover(|link| link.text_color(theme().text))
                        .child("View release on GitHub")
                        .child(crate::icon::stroke(EXTERNAL, theme().text_secondary, 11., 1.8))
                        .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url))),
                )
        });

    div()
        .absolute()
        .left(px(44. + 12.))
        .bottom(px(0.))
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::BottomLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("update-panel")
                            .debug_selector(|| "update-panel".into())
                            .occlude()
                            .relative()
                            .left(px(-5. * (1. - t)))
                            .top(px(3. * (1. - t)))
                            .w(px(PANEL_W))
                            .h(px(max_height))
                            .overflow_y_scroll()
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .text_color(theme().text)
                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                if *hovered {
                                    this.features.get::<State>().leave += 1;
                                } else {
                                    leave(this, cx);
                                }
                            }))
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                let state = this.features.get::<State>();
                                if state.open && !state.applying && state.phase.is_none() {
                                    close(this, cx);
                                }
                            }))
                            .child(body),
                    ),
            )
            .with_priority(2),
        )
        .into_any_element()
}

const DOWNLOAD: &str = "M12 15V3 M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5";
const REFRESH: &str = "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5";
const CHEVRON: &str = "m6 9 6 6 6-6";
// Lucide rotate-cw and check.
const ROTATE: &str = "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5";
const CHECK: &str = "M20 6 9 17l-5-5";
const CHEVRON_UP: &str = "m18 15-6-6-6 6";
const EXTERNAL: &str =
    "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";

#[cfg(test)]
#[path = "update/tests.rs"]
mod tests;
