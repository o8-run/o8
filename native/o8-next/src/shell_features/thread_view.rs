// Thread › View (#5309): a thread's provider CLI, resumed on the thread's own
// session in the native terminal, shown in the chat's place. The chat surface
// stays open behind it and keeps its live transcript, so switching back shows
// what was typed in the terminal. A CLI started before newer chat turns is
// resumed again, so it reads them.
use super::*;
use crate::terminal::Pane;
use gpui::WeakEntity;
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct ThreadView;
register_shell_feature!(ThreadView);
impl ShellFeature for ThreadView {
    fn extension(&self) -> Option<&'static dyn registry::ShellExtension> {
        Some(&ThreadView)
    }
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 210,
            run: |s, _, window, cx| tick(s, window, cx),
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 5,
            dispatch: |s, event, window, cx| {
                let key = &event.keystroke;
                if s.features.read::<Views>().is_some_and(|v| v.menu) && key.key == "escape" {
                    s.features.get::<Views>().menu = false;
                    cx.notify();
                    return KeyResult::Handled;
                }
                // ⌃⌥V, as the tab menu shows it.
                let m = key.modifiers;
                if key.key != "v" || !m.control || !m.alt || m.shift || m.platform {
                    return KeyResult::Unhandled;
                }
                if toggle(s, window, cx) {
                    KeyResult::Handled
                } else {
                    KeyResult::Unhandled
                }
            },
        }]
    }
}
impl registry::ShellExtension for ThreadView {
    fn overlay(&self, s: &mut Shell) -> Option<AnyElement> {
        let key = s.key(&s.active()?);
        let views = s.features.read::<Views>()?;
        let view = views.threads.get(&key)?;
        view.terminal
            .then(|| element(&view.state, view.stale, views.shell.clone()))
    }
}

/// The CLI line that resumes a thread's provider session, from its history
/// record (`backend` and `orchestratorSessionIds`, as classic stores them).
/// `None` is a runtime with no terminal view; `Some(Err)` has no session yet.
pub(super) fn resume_line(
    backend: Option<&str>,
    record: &serde_json::Value,
) -> Option<Result<String, &'static str>> {
    let ids = &record["orchestratorSessionIds"];
    // Fable is a Claude REPL lead and binds the Claude session.
    let provider = match record["backend"].as_str().or(backend) {
        Some("claude" | "fable") => "claude",
        Some("codex") => "codex",
        Some(_) => return None,
        // Older records name no backend; classic infers it from the ids.
        None if ids["claude"].is_string() => "claude",
        None if ids["codex"].is_string() => "codex",
        None => return None,
    };
    let id = ids[provider].as_str().map(str::trim).unwrap_or_default();
    let id = id.strip_prefix("claude-code:").unwrap_or(id);
    // The line is typed into a shell: an id is only ever a plain token.
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Some(Err(NO_SESSION));
    }
    // `exec` makes the shell the CLI: when the CLI quits, so does the shell.
    Some(Ok(match provider {
        "claude" => format!("exec claude --resume {id}"),
        _ => format!("exec codex resume {id}"),
    }))
}

pub(super) const NO_SESSION: &str =
    "No resumable session yet. Send a message in chat first, then switch to Terminal View.";

/// What the thread asks the terminal harness for: its own shell, kept by a
/// stable owner key in the thread's workspace, and the line run there.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Launch {
    pub cwd: String,
    pub owner: String,
    pub line: String,
}

pub(super) enum State {
    Opening,
    Unavailable(String),
    Open(Entity<Pane>),
}

/// Whether the running CLI has read the chat's newest turns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Stale {
    Current,
    /// Chat has turns newer than the CLI's launch, and the CLI is running.
    Newer,
    /// Reopen was pressed: Ctrl-C until the CLI exits, then resume again.
    Reopening {
        sent: u8,
        at: Instant,
    },
    /// The CLI kept running after the last Ctrl-C.
    Stuck,
}

/// Reopen sends at most this many Ctrl-Cs, this far apart.
const REOPEN_INTERRUPTS: u8 = 3;
const REOPEN_GAP: Duration = Duration::from_secs(1);
pub(super) const NEWER_TURNS: &str = "Chat has newer turns";
const EXITED: &str = "Terminal exited";
pub(super) const DID_NOT_EXIT: &str = "The CLI didn't exit. Quit it, then press Reopen.";

pub(super) struct Thread {
    /// The conversation this view resumes; the chat can move to another.
    pub id: String,
    pub terminal: bool,
    pub state: State,
    pub launch: Option<Launch>,
    /// The shell was already running, so its CLI was left as it was.
    pub adopted: bool,
    pub stale: Stale,
}

#[derive(Default)]
pub(super) struct Views {
    /// By the thread tab's content key.
    pub threads: HashMap<String, Thread>,
    pub menu: bool,
    /// The shell, for the overlay's Reopen button.
    shell: Option<WeakEntity<Shell>>,
}

/// The thread a session tab shows, when its runtime has a terminal view.
fn active_thread(s: &Shell, cx: &App) -> Option<(String, Session)> {
    let tab = s.active()?;
    let Tab::Session(tab_id) = &tab else {
        return None;
    };
    let key = s.key(&tab);
    let shown = match s.content.get(&key) {
        Some(Content::Session(view)) => view.read(cx).shown_thread(),
        _ => None,
    }
    .unwrap_or_else(|| tab_id.clone());
    let session = s
        .sessions
        .iter()
        .find(|session| session.id == shown || session.list_id() == shown)?;
    (session.runtime != "cloud"
        && resume_line(session.backend.as_deref(), &serde_json::Value::Null).is_some())
    .then(|| (key, session.clone()))
}

pub(super) fn terminal_shown(s: &Shell, cx: &App) -> Option<bool> {
    let (key, _) = active_thread(s, cx)?;
    Some(
        s.features
            .read::<Views>()
            .and_then(|v| v.threads.get(&key))
            .is_some_and(|t| t.terminal),
    )
}

/// Switches the active thread between chat and terminal. False when the
/// thread has no terminal view.
pub(super) fn toggle(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) -> bool {
    let Some((key, session)) = active_thread(s, cx) else {
        return false;
    };
    s.features.get::<Views>().menu = false;
    let views = s.features.get::<Views>();
    // Leaving always returns to chat; entering reuses a live shell.
    let reuse = views.threads.get(&key).is_some_and(|t| {
        t.id == session.id
            && (t.terminal
                || match &t.state {
                    State::Open(pane) => {
                        let pane = pane.read(cx);
                        pane.ready || pane.notice != EXITED
                    }
                    State::Opening => true,
                    State::Unavailable(_) => false,
                })
    });
    if let Some(thread) = views.threads.get_mut(&key).filter(|_| reuse) {
        thread.terminal = !thread.terminal;
        let terminal = thread.terminal;
        let pane = match &thread.state {
            State::Open(pane) => Some(pane.clone()),
            _ => None,
        };
        let shown = pane.filter(|_| terminal);
        match &shown {
            Some(pane) => pane.read(cx).focus_handle().focus(window),
            None if !terminal => s.restore_focus(window, cx),
            // Nothing to type into yet: the shell keeps keys, so ⌃⌥V still works.
            None => s.focus.focus(window),
        }
        remember(s, &session.id, terminal);
        turns(s, key.clone(), &session.id, terminal, cx);
        if shown.is_some() {
            check(s, key, window, cx);
        }
        cx.notify();
        return true;
    }
    remember(s, &session.id, true);
    turns(s, key.clone(), &session.id, true, cx);
    open(s, key, session, window, cx);
    true
}

/// Opens the thread's shell and resumes its CLI there, or adopts the shell
/// still running under the thread's owner key.
fn open(
    s: &mut Shell,
    key: String,
    session: Session,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    s.features.get::<Views>().threads.insert(
        key.clone(),
        Thread {
            id: session.id.clone(),
            terminal: true,
            state: State::Opening,
            launch: None,
            adopted: false,
            stale: Stale::Current,
        },
    );
    s.focus.focus(window);
    cx.notify();
    let workspace = session.workspace();
    let client = s.panel_client(&workspace);
    let cwd = super::super::session::workspace_path(&workspace).to_owned();
    let owner = format!("o8-next:{workspace}:thread:{}", session.id);
    let backend = session.backend.clone();
    let id = session.id.clone();
    let opener = client.clone();
    let task = cx.background_executor().spawn(async move {
        let record: serde_json::Value = opener
            .get("/api/v2/chat-history", &[("tabId", &id), ("limit", "1")])
            .map_err(|error| format!("Could not read this thread: {error}"))?;
        let line = match resume_line(backend.as_deref(), &record) {
            Some(Ok(line)) => line,
            _ => return Err(NO_SESSION.to_owned()),
        };
        let launch = Launch { cwd, owner, line };
        // The owner key adopts this thread's shell when it is still running,
        // such as after the tab was closed or the app restarted. Its CLI is
        // already there, and typing the line would send it as a prompt.
        let running: serde_json::Value = opener
            .get("/api/mobile/terminal-sessions", &[])
            .map_err(|error| format!("Could not list terminals: {error}"))?;
        let name = open_terminal(&opener, &launch)?;
        let adopted = running["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|session| session["name"] == name.as_str());
        Ok((launch, name, adopted))
    });
    cx.spawn_in(window, async move |this, cx| {
        let result = task.await;
        let _ = this.update_in(cx, |s, window, cx| {
            let Some(thread) = s
                .features
                .get::<Views>()
                .threads
                .get_mut(&key)
                .filter(|t| t.id == session.id && matches!(t.state, State::Opening))
            else {
                return;
            };
            match result {
                Ok((launch, name, adopted)) => {
                    let line = launch.line.clone();
                    let pane = cx.new(|cx| {
                        let mut pane = Pane::attached(client, name, cx);
                        if !adopted {
                            pane.run_line(line, cx);
                        }
                        pane
                    });
                    thread.launch = Some(launch);
                    thread.adopted = adopted;
                    // Only a shown terminal takes focus from the window.
                    if thread.terminal && s.active().is_some_and(|tab| s.key(&tab) == key) {
                        pane.read(cx).focus_handle().focus(window);
                    }
                    let Some(thread) = s.features.get::<Views>().threads.get_mut(&key) else {
                        return;
                    };
                    thread.state = State::Open(pane);
                    if adopted {
                        check(s, key, window, cx);
                    } else {
                        launched(s, &session.id);
                    }
                }
                Err(error) => thread.state = State::Unavailable(error),
            }
            cx.notify();
        });
    })
    .detach();
}

const TERMINAL_TURNS: &str = "/api/v2/chat-history/terminal-turns";
/// A long terminal visit imports in rounds of the server's cap, at most this many.
const IMPORT_ROUNDS: usize = 20;

fn post_turns(client: &Client, id: &str, action: &str) -> Result<serde_json::Value, String> {
    let url = client
        .url(TERMINAL_TURNS)
        .map_err(|error| error.to_string())?;
    let response = client
        .request("POST", &url)
        .send_json(serde_json::json!({"tabId": id, "action": action}))
        .map_err(|error| error.to_string())?;
    Client::read(response)
}

pub(super) fn turns_text(count: u64) -> String {
    let noun = if count == 1 { "turn" } else { "turns" };
    format!("{count} {noun} from the terminal")
}

/// Terminal View opening marks where the CLI's session file ends; closing it
/// copies what the CLI wrote since into the chat, which says how many turns.
/// Opening also catches up a visit that never closed, as after a quit.
fn turns(s: &mut Shell, key: String, id: &str, opening: bool, cx: &mut Context<Shell>) {
    let workspace = s
        .sessions
        .iter()
        .find(|session| session.id == id)
        .map(|session| session.workspace())
        .unwrap_or_default();
    let client = s.panel_client(&workspace);
    let id = id.to_owned();
    let task = cx.background_executor().spawn(async move {
        if opening {
            return post_turns(&client, &id, "mark")
                .map_or(0, |reply| reply["turns"].as_u64().unwrap_or(0));
        }
        let mut count = 0;
        for _ in 0..IMPORT_ROUNDS {
            let Ok(reply) = post_turns(&client, &id, "import") else {
                break;
            };
            count += reply["turns"].as_u64().unwrap_or(0);
            if reply["more"] != true {
                break;
            }
        }
        count
    });
    cx.spawn(async move |this, cx| {
        let count = task.await;
        if count == 0 {
            return;
        }
        let _ = this.update(cx, |s, cx| {
            super::toasts::info(turns_text(count), cx);
            if let Some(Content::Session(view)) = s.content.get(&key) {
                view.update(cx, |view, cx| view.shell_reload_history(cx));
            }
        });
    })
    .detach();
}

/// The CLI line was typed now.
fn launched(s: &mut Shell, id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    s.state.terminal_launched.insert(id.to_owned(), now);
    s.persist();
}

/// The newest chat turn's time, leaving out turns imported from the terminal.
pub(super) fn newest_chat_turn(record: &serde_json::Value) -> Option<u64> {
    record["messages"]
        .as_array()?
        .iter()
        .filter(|m| !m["id"].as_str().is_some_and(|id| id.starts_with("cli-")))
        .filter_map(|m| m["timestamp"].as_f64())
        .map(|t| t as u64)
        .max()
}

/// Compares the chat's newest turn with the CLI's launch, and offers Reopen
/// when chat is newer. Nothing is typed into the running shell: an idle CLI
/// cannot be told from one mid-turn, or from a prompt of its own.
fn check(s: &mut Shell, key: String, window: &mut Window, cx: &mut Context<Shell>) {
    let Some(thread) = s.features.read::<Views>().and_then(|v| v.threads.get(&key)) else {
        return;
    };
    let id = thread.id.clone();
    let Some(&launched_at) = s.state.terminal_launched.get(&id) else {
        return;
    };
    let workspace = s
        .sessions
        .iter()
        .find(|session| session.id == id)
        .map(|session| session.workspace())
        .unwrap_or_default();
    let client = s.panel_client(&workspace);
    let tab = id.clone();
    let task = cx.background_executor().spawn(async move {
        client
            .get::<serde_json::Value>("/api/v2/chat-history", &[("tabId", &tab), ("limit", "20")])
            .ok()
            .and_then(|record| newest_chat_turn(&record))
    });
    cx.spawn_in(window, async move |this, cx| {
        let newest = task.await;
        let _ = this.update_in(cx, |s, _, cx| {
            if newest.is_none_or(|newest| newest <= launched_at) {
                return;
            }
            let Some(thread) = s.features.get::<Views>().threads.get_mut(&key) else {
                return;
            };
            if thread.id == id
                && thread.stale == Stale::Current
                && matches!(&thread.state, State::Open(pane) if pane.read(cx).notice != EXITED)
            {
                thread.stale = Stale::Newer;
                cx.notify();
            }
        });
    })
    .detach();
}

/// Reopen: stop the running CLI so it can resume with the newer turns.
fn reopen(s: &mut Shell, cx: &mut Context<Shell>) {
    let Some(key) = s.active().map(|tab| s.key(&tab)) else {
        return;
    };
    if let Some(thread) = s.features.get::<Views>().threads.get_mut(&key) {
        thread.stale = Stale::Reopening {
            sent: 0,
            at: Instant::now() - REOPEN_GAP,
        };
        cx.notify();
    }
}

/// Moves each Reopen along. The resume line is `exec`ed, so the shell ends
/// with the CLI; only then is the CLI resumed, in a new shell. Until then it
/// gets Ctrl-C, at most [`REOPEN_INTERRUPTS`] times.
fn reopening(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let keys: Vec<String> = s
        .features
        .get::<Views>()
        .threads
        .iter()
        .filter(|(_, t)| matches!(t.stale, Stale::Reopening { .. }))
        .map(|(key, _)| key.clone())
        .collect();
    for key in keys {
        let views = s.features.get::<Views>();
        let Some(thread) = views.threads.get_mut(&key) else {
            continue;
        };
        let Stale::Reopening { sent, at } = thread.stale else {
            continue;
        };
        let State::Open(pane) = &thread.state else {
            thread.stale = Stale::Current;
            continue;
        };
        let pane = pane.clone();
        let exited = pane.read(cx).notice == EXITED;
        let id = thread.id.clone();
        if exited {
            // The exec'd CLI took its shell with it: a new shell resumes it.
            let terminal = thread.terminal;
            views.threads.remove(&key);
            if let Some(session) = s.sessions.iter().find(|x| x.id == id).cloned() {
                open(s, key.clone(), session, window, cx);
                if let Some(thread) = s.features.get::<Views>().threads.get_mut(&key) {
                    thread.terminal = terminal;
                }
            }
        } else if at.elapsed() < REOPEN_GAP {
            continue;
        } else if sent < REOPEN_INTERRUPTS {
            thread.stale = Stale::Reopening {
                sent: sent + 1,
                at: Instant::now(),
            };
            pane.update(cx, |pane, cx| pane.send_interrupt(cx));
        } else {
            thread.stale = Stale::Stuck;
        }
        cx.notify();
    }
}

/// The view choice, kept per thread across launches.
fn remember(s: &mut Shell, id: &str, terminal: bool) {
    let changed = if terminal {
        s.state.terminal_views.insert(id.to_owned())
    } else {
        s.state.terminal_views.remove(id)
    };
    if changed {
        s.persist();
    }
}

/// The workspace's terminal harness: `terminal-create` with the thread's
/// owner key reserves its shell, or adopts it after a restart.
fn open_terminal(client: &Client, launch: &Launch) -> Result<String, String> {
    client.create_terminal(&launch.cwd, &launch.owner)
}

fn tick(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if s.features
        .read::<Views>()
        .is_some_and(|v| v.shell.is_none())
    {
        s.features.get::<Views>().shell = Some(cx.entity().downgrade());
    }
    // A thread left in Terminal View opens in it again, as after a relaunch.
    if let Some((key, session)) = active_thread(s, cx)
        && s.state.terminal_views.contains(&session.id)
        && s.features
            .read::<Views>()
            .is_none_or(|v| v.threads.get(&key).is_none_or(|t| t.id != session.id))
    {
        toggle(s, window, cx);
    }
    if s.features.read::<Views>().is_none() {
        return;
    }
    reopening(s, window, cx);
    let active = s.active().map(|tab| s.key(&tab));
    // The chat moved to another conversation, or the tab has no thread view:
    // the view returns to chat and the menu closes.
    let shown = active_thread(s, cx);
    let views = s.features.get::<Views>();
    if shown.is_none() {
        views.menu = false;
    }
    if let Some(thread) = active.as_ref().and_then(|key| views.threads.get_mut(key))
        && thread.terminal
        && shown
            .as_ref()
            .is_none_or(|(_, session)| session.id != thread.id)
    {
        thread.terminal = false;
        let (key, id) = (active.clone().unwrap_or_default(), thread.id.clone());
        turns(s, key, &id, false, cx);
        cx.notify();
    }
    let content: Vec<String> = s.content.keys().cloned().collect();
    let views = s.features.get::<Views>();
    // A closed thread drops its pane, which detaches from the shell.
    views.threads.retain(|key, _| content.contains(key));
    let panes: Vec<(Entity<Pane>, bool)> = views
        .threads
        .iter()
        .filter_map(|(key, t)| match &t.state {
            State::Open(pane) => Some((pane.clone(), t.terminal && active.as_ref() == Some(key))),
            _ => None,
        })
        .collect();
    // Hidden panes keep reading, so an exit is known when the view returns.
    for (pane, visible) in panes {
        pane.update(cx, |pane, cx| pane.poll_visible(visible, cx));
    }
}

fn element(state: &State, stale: Stale, shell: Option<WeakEntity<Shell>>) -> AnyElement {
    match state {
        State::Open(pane) => div()
            .debug_selector(|| "thread-terminal-view".into())
            .size_full()
            .flex()
            .flex_col()
            .when_some(banner(stale, shell), |d, banner| d.child(banner))
            .child(div().flex_1().min_h_0().child(pane.clone()))
            .into_any_element(),
        State::Opening => notice("Opening terminal view…"),
        State::Unavailable(text) => notice(text),
    }
}

/// The strip over a CLI that has not read the chat's newest turns.
fn banner(stale: Stale, shell: Option<WeakEntity<Shell>>) -> Option<AnyElement> {
    let (text, button) = match stale {
        Stale::Current => return None,
        Stale::Newer => (NEWER_TURNS, true),
        Stale::Reopening { .. } => ("Reopening…", false),
        Stale::Stuck => (DID_NOT_EXIT, true),
    };
    Some(
        div()
            .debug_selector(|| "thread-terminal-stale".into())
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(6.))
            .border_b_1()
            .border_color(theme().border)
            .text_size(px(12.))
            .text_color(theme().text_secondary)
            .child(text)
            .when(button, |d| {
                d.child(
                    div()
                        .id("thread-terminal-reopen")
                        .debug_selector(|| "thread-terminal-reopen".into())
                        .px(px(8.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .text_color(theme().text)
                        .hover(|row| row.bg(theme().hover))
                        .child("Reopen")
                        .on_click(move |_, _, cx| {
                            if let Some(shell) = shell.as_ref().and_then(|s| s.upgrade()) {
                                shell.update(cx, |s, cx| reopen(s, cx));
                            }
                        }),
                )
            })
            .into_any_element(),
    )
}

fn notice(text: &str) -> AnyElement {
    div()
        .debug_selector(|| "thread-terminal-notice".into())
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .px(px(24.))
        .text_color(theme().text_secondary)
        .child(text.to_owned())
        .into_any_element()
}

/// The thread header's view menu, for runtimes with a terminal view.
pub(super) fn button(s: &mut Shell, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let terminal = terminal_shown(s, cx)?;
    let open = s.features.get::<Views>().menu;
    let label = if terminal {
        "Switch to Chat View"
    } else {
        "Switch to Terminal View"
    };
    let toggle_button = super::header::icon_button(
        "thread-view-menu",
        MORE,
        15.,
        1.7,
        if open { "" } else { "Thread view" },
        true,
    )
    .on_click(cx.listener(|this, _, _, cx| {
        let views = this.features.get::<Views>();
        views.menu = !views.menu;
        cx.notify();
    }));
    Some(
        div()
            .relative()
            .flex_shrink_0()
            .child(toggle_button)
            .when(open, |anchor| {
                anchor.child(
                    gpui::deferred(
                        div()
                            .absolute()
                            .top(px(30.))
                            .right_0()
                            .w(px(240.))
                            .p(px(4.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(theme().border)
                            .bg(theme().background)
                            .shadow_lg()
                            .child(
                                div()
                                    .id("thread-view-toggle")
                                    .debug_selector(|| "thread-view-toggle".into())
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .px(px(10.))
                                    .py(px(6.))
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(|row| row.bg(theme().hover))
                                    .text_color(theme().text)
                                    .child(label)
                                    .child(div().text_color(theme().text_muted).child("⌃⌥V"))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        toggle(this, window, cx);
                                    })),
                            ),
                    )
                    .with_priority(1),
                )
            })
            .into_any_element(),
    )
}

const MORE: &str = "M5 12h.01 M12 12h.01 M19 12h.01";

#[cfg(test)]
pub(super) fn thread<'a>(s: &'a Shell, cx: &App) -> Option<&'a Thread> {
    let (key, _) = active_thread(s, cx)?;
    s.features.read::<Views>()?.threads.get(&key)
}
