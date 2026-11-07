use super::thread_view::{NO_SESSION, Stale, State, Views, newest_chat_turn, resume_line, thread};
use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;
struct ThreadViewTests;
register_shell_feature!(ThreadViewTests);
impl ShellFeature for ThreadViewTests {}

#[test]
fn thread_view_resume_line_per_provider_and_no_session() {
    let record =
        |backend: Value, ids: Value| json!({"backend": backend, "orchestratorSessionIds": ids});
    let line = |backend: Option<&str>, record: Value| resume_line(backend, &record);
    assert_eq!(
        line(
            None,
            record(json!("claude"), json!({"claude": "5b1c9e70-aa"}))
        ),
        Some(Ok("exec claude --resume 5b1c9e70-aa".into()))
    );
    // A Fable lead binds the Claude session, and classic's prefix is not part of the id.
    assert_eq!(
        line(
            None,
            record(json!("fable"), json!({"claude": " claude-code:abc_1 "}))
        ),
        Some(Ok("exec claude --resume abc_1".into()))
    );
    assert_eq!(
        line(
            None,
            record(
                json!("codex"),
                json!({"codex": "0199a2b3-c4d5", "claude": "x"})
            )
        ),
        Some(Ok("exec codex resume 0199a2b3-c4d5".into()))
    );
    // Older records name no backend: the thread's, else the ids, decide.
    assert_eq!(
        line(Some("codex"), record(Value::Null, json!({"codex": "t1"}))),
        Some(Ok("exec codex resume t1".into()))
    );
    assert_eq!(
        line(None, record(Value::Null, json!({"codex": "t2"}))),
        Some(Ok("exec codex resume t2".into()))
    );
    // No session yet, or one that is not a plain token, never reaches a shell.
    for ids in [
        json!({}),
        json!({"claude": null}),
        json!({"claude": "  "}),
        json!({"claude": "a; rm -rf ~"}),
        json!({"claude": "$(id)"}),
    ] {
        assert_eq!(
            line(None, record(json!("claude"), ids)),
            Some(Err(NO_SESSION))
        );
    }
    // Runtimes without a TUI resume command have no terminal view.
    assert_eq!(
        line(None, record(json!("pi"), json!({"claude": "x"}))),
        None
    );
    assert_eq!(line(Some("openclaw"), Value::Null), None);
    assert_eq!(line(None, Value::Null), None);
}

fn settle(v: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(200);
    while Instant::now() < until {
        // The shell's pump, which a test window's clock does not advance.
        if let Some(shell) = v.update(|window, _| window.root::<Shell>().flatten()) {
            shell.update_in(v, |s, window, cx| s.tick(false, window, cx));
        }
        v.run_until_parked();
        draw(v);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn until(v: &mut VisualTestContext, what: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(45);
    while !done(v) {
        assert!(Instant::now() < deadline, "timed out: {what}");
        settle(v);
    }
}

fn chat(s: &Entity<Shell>, v: &VisualTestContext) -> Entity<crate::ui::Surface> {
    s.read_with(v, |s, _| {
        match s.active().and_then(|t| s.content.get(&s.key(&t))) {
            Some(Content::Session(view)) => view.clone(),
            _ => panic!("the active tab must be a thread"),
        }
    })
}

fn click(v: &mut VisualTestContext, id: &'static str) {
    draw(v);
    let bounds = v.debug_bounds(id).unwrap_or_else(|| panic!("missing {id}"));
    v.simulate_click(bounds.center(), Modifiers::default());
    settle(v);
}

#[gpui::test]
fn thread_view_switches_to_the_resumed_cli_in_the_workspace_terminal_and_back(
    cx: &mut TestAppContext,
) {
    // The shell fixture with the production ws-server's terminal host.
    let f = Fixture::start_mode(false, "--terminal");
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("thread-view.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    let (id, workspace) = s.read_with(&v, |s, _| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("a thread opens first")
        };
        (id, s.state.selected.clone().unwrap())
    });
    let surface = chat(&s, &v);
    let rows = surface.read_with(&v, |c, _| c.shell_ready());
    assert!(rows);

    // No provider session yet: the terminal view says so and opens nothing.
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the no-session state", |v| {
        s.read_with(v, |s, cx| {
            thread(s, cx)
                .is_some_and(|t| matches!(&t.state, State::Unavailable(text) if text == NO_SESSION))
        })
    });
    assert!(v.debug_bounds("thread-terminal-notice").is_some());
    assert!(s.read_with(&v, |s, cx| thread(s, cx).unwrap().launch.is_none()));
    // The choice is kept per thread (#5309), and leaving forgets it.
    let session = s.read_with(&v, |s, cx| thread(s, cx).unwrap().id.clone());
    saved(&mut v, &f, &[&session]);
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    assert!(s.read_with(&v, |s, cx| !thread(s, cx).unwrap().terminal));
    assert!(v.debug_bounds("thread-terminal-notice").is_none());
    saved(&mut v, &f, &[]);

    // Bind a Codex session the way classic stores it.
    let record: Value = f
        .client
        .get("/api/v2/chat-history", &[("tabId", &id)])
        .unwrap();
    let url = f.client.url("/api/v2/chat-history").unwrap();
    f.client
        .request("POST", &url)
        .send_json(json!({
            "tabId": id, "messages": record["messages"], "backend": "codex",
            "orchestratorSessionIds": {"codex": "0199-thread-view-session"},
        }))
        .unwrap();

    // The header menu opens the terminal view.
    click(&mut v, "thread-view-menu");
    click(&mut v, "thread-view-toggle");
    let line = "exec codex resume 0199-thread-view-session";
    until(&mut v, "the CLI line typed into the thread's shell", |v| {
        s.read_with(v, |s, cx| match thread(s, cx).map(|t| &t.state) {
            Some(State::Open(pane)) => pane.read(cx).command_output(line).is_some(),
            Some(State::Unavailable(error)) => panic!("terminal view failed: {error}"),
            _ => false,
        })
    });
    let launch = s.read_with(&v, |s, cx| thread(s, cx).unwrap().launch.clone().unwrap());
    let cwd = crate::shell::session::workspace_path(&workspace).to_owned();
    assert_eq!(launch.cwd, cwd);
    assert_eq!(launch.line, line);
    assert_eq!(launch.owner, format!("o8-next:{workspace}:thread:{id}"));
    assert!(v.debug_bounds("thread-terminal-view").is_some());
    // The shell the harness opened runs in the thread's workspace.
    let pane = s.read_with(&v, |s, cx| match &thread(s, cx).unwrap().state {
        State::Open(pane) => pane.clone(),
        _ => unreachable!(),
    });
    pane.update(&mut v, |pane, cx| pane.run_line("pwd".into(), cx));
    until(&mut v, "pwd in the thread's shell", |v| {
        pane.read_with(v, |pane, _| {
            pane.command_output("pwd")
                .is_some_and(|out| out.lines.iter().any(|l| l.trim() == cwd))
        })
    });

    // Back to chat: the same transcript view, and the shell stays attached.
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    assert!(v.debug_bounds("thread-terminal-view").is_none());
    assert_eq!(chat(&s, &v).entity_id(), surface.entity_id());
    assert!(surface.read_with(&v, |c, _| c.shell_ready()));
    assert!(pane.read_with(&v, |pane, _| pane.ready));
    // Returning reuses that shell instead of launching the CLI again.
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    let again = s.read_with(&v, |s, cx| match &thread(s, cx).unwrap().state {
        State::Open(pane) => pane.entity_id(),
        _ => panic!("the open shell must be reused"),
    });
    assert_eq!(again, pane.entity_id());
    assert!(v.debug_bounds("thread-terminal-view").is_some());
    assert!(!s.read_with(&v, |s, cx| thread(s, cx).unwrap().adopted));

    // Closing the thread drops its pane; the shell, and its CLI, keep running.
    // The thread was left in Terminal View, so it opens there again, adopting
    // that shell and typing nothing into it.
    saved(&mut v, &f, &[&session]);
    s.update_in(&mut v, |s, window, cx| {
        s.features.get::<Views>().threads.clear();
        // As closing a tab does, the shell hands focus back.
        s.restore_focus(window, cx);
    });
    drop(pane);
    let adopted = |s: &Entity<Shell>, v: &mut VisualTestContext| {
        s.read_with(v, |s, cx| {
            thread(s, cx).is_some_and(|t| {
                t.terminal && t.adopted && matches!(&t.state, State::Open(p) if p.read(cx).ready)
            })
        })
    };
    until(&mut v, "the running shell adopted", |v| adopted(&s, v));
    assert!(v.debug_bounds("thread-terminal-view").is_some());

    // A relaunch reopens the thread in Terminal View on the same shell.
    let state = crate::shell_state::State::load(&f.root.join("thread-view.json")).unwrap();
    let (again, mut relaunched) =
        open(f.client.clone(), f.root.join("thread-view.json"), state, cx);
    ready(&again, &mut relaunched);
    until(
        &mut relaunched,
        "the relaunched thread in Terminal View",
        |v| adopted(&again, v),
    );
    assert!(relaunched.debug_bounds("thread-terminal-view").is_some());
    relaunched.simulate_keystrokes("ctrl-alt-v");
    settle(&mut relaunched);
    assert!(relaunched.debug_bounds("thread-terminal-view").is_none());
    saved(&mut relaunched, &f, &[]);
}

/// Waits for the saved shell state to keep exactly these threads in
/// Terminal View; the state writer saves off the UI thread.
fn saved(v: &mut VisualTestContext, f: &Fixture, ids: &[&str]) {
    let path = f.root.join("thread-view.json");
    until(v, "the saved Terminal View threads", |_| {
        crate::shell_state::State::load(&path)
            .is_ok_and(|state| state.terminal_views.iter().eq(ids.iter().copied()))
    });
}

/// A chat turn saved now, newer than any CLI launched before it.
fn chat_turn(f: &Fixture, id: &str, text: &str) {
    let mut record: Value = f
        .client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let messages = record["messages"].as_array_mut().unwrap();
    messages.push(json!({"role": "user", "content": text, "timestamp": now + 1_000}));
    let url = f.client.url("/api/v2/chat-history").unwrap();
    f.client
        .request("POST", &url)
        .send_json(json!({
            "tabId": id, "messages": messages, "backend": "codex",
            "orchestratorSessionIds": {"codex": "0199-thread-view-session"},
        }))
        .unwrap();
}

#[gpui::test]
fn thread_view_resumes_the_cli_again_after_newer_chat_turns(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--terminal");
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("thread-view.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    let id = s.read_with(&v, |s, _| match s.active() {
        Some(Tab::Session(id)) => id,
        _ => panic!("a thread opens first"),
    });
    chat_turn(&f, &id, "Earlier chat turn");
    let line = "exec codex resume 0199-thread-view-session";
    let launched = |s: &Entity<Shell>, v: &VisualTestContext| {
        s.read_with(v, |s, _| s.state.terminal_launched.get(&id).copied())
    };
    let pane = |s: &Entity<Shell>, v: &VisualTestContext| {
        s.read_with(v, |s, cx| match &thread(s, cx).unwrap().state {
            State::Open(pane) => Some(pane.clone()),
            _ => None,
        })
    };
    let stale = |s: &Entity<Shell>, v: &VisualTestContext| {
        s.read_with(v, |s, cx| thread(s, cx).unwrap().stale)
    };
    let typed = |s: &Entity<Shell>, v: &VisualTestContext| {
        s.read_with(v, |s, cx| match thread(s, cx).map(|t| &t.state) {
            Some(State::Open(pane)) => pane.read(cx).command_output(line).is_some(),
            _ => false,
        })
    };

    // The first launch records when the CLI started.
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the CLI line typed", |v| typed(&s, v));
    let first = launched(&s, &v).expect("the launch time is kept");
    assert_eq!(stale(&s, &v), Stale::Current);

    // A CLI still running, as an exec'd one is: the shell stays connected
    // (`ready`) with no prompt of its own. Ctrl-C ends it, and its shell.
    let shell = pane(&s, &v).unwrap();
    shell.update(&mut v, |pane, cx| pane.run_line("exec sleep 30".into(), cx));
    until(&mut v, "the CLI running", |v| {
        shell.read_with(v, |pane, _| pane.command_output("exec sleep 30").is_some())
    });
    settle(&mut v);
    let before = shell.read_with(&v, |pane, _| pane.sent.len());

    // A newer chat turn: the notice offers Reopen, and the running CLI
    // receives nothing (#5309 regression: a typed line once answered a
    // prompt the CLI was showing).
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    chat_turn(&f, &id, "A turn sent from chat");
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the newer-turns notice", |v| {
        stale(&s, v) == Stale::Newer
    });
    settle(&mut v);
    assert!(v.debug_bounds("thread-terminal-stale").is_some());
    assert!(shell.read_with(&v, |pane, _| pane.ready));
    assert_eq!(
        shell.read_with(&v, |pane, _| pane.sent[before..].to_vec()),
        Vec::<String>::new()
    );
    assert_eq!(launched(&s, &v), Some(first));

    // Reopen stops it with Ctrl-C only, then resumes the CLI on the same
    // session in a new shell.
    click(&mut v, "thread-terminal-reopen");
    until(&mut v, "the CLI resumed in a new shell", |v| {
        launched(&s, v).is_some_and(|at| at > first) && typed(&s, v)
    });
    let sent = shell.read_with(&v, |pane, _| pane.sent[before..].to_vec());
    assert!(
        !sent.is_empty() && sent.iter().all(|input| input == "\x03"),
        "{sent:?}"
    );
    let fresh = pane(&s, &v).unwrap();
    assert_ne!(fresh.entity_id(), shell.entity_id());
    assert_eq!(stale(&s, &v), Stale::Current);
    assert!(v.debug_bounds("thread-terminal-stale").is_none());
    let resumed = launched(&s, &v).unwrap();

    // A CLI that ignores Ctrl-C gets three of them, a second apart, then the
    // note; nothing else reaches it and nothing is resumed.
    let stubborn = "exec sh -c \"trap '' INT; sleep 60\"";
    fresh.update(&mut v, |pane, cx| pane.run_line(stubborn.into(), cx));
    until(&mut v, "the stubborn CLI running", |v| {
        fresh.read_with(v, |pane, _| pane.command_output(stubborn).is_some())
    });
    settle(&mut v);
    let before = fresh.read_with(&v, |pane, _| pane.sent.len());
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    chat_turn(&f, &id, "One more chat turn");
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the newer-turns notice again", |v| {
        stale(&s, v) == Stale::Newer
    });
    let pressed = Instant::now();
    click(&mut v, "thread-terminal-reopen");
    until(&mut v, "the didn't-exit note", |v| {
        stale(&s, v) == Stale::Stuck
    });
    assert!(pressed.elapsed() >= Duration::from_secs(2));
    assert!(v.debug_bounds("thread-terminal-reopen").is_some());
    assert_eq!(
        fresh.read_with(&v, |pane, _| pane.sent[before..].to_vec()),
        vec!["\x03".to_owned(); 3]
    );
    assert_eq!(launched(&s, &v), Some(resumed));
    assert_eq!(pane(&s, &v).unwrap().entity_id(), fresh.entity_id());
}

#[test]
fn thread_view_newest_chat_turn_leaves_out_terminal_imports() {
    let record = json!({"messages": [
        {"id": "user-1", "role": "user", "timestamp": 100},
        {"id": "assistant-1", "role": "assistant", "timestamp": 200.0},
        {"id": "cli-codex-turn-1", "role": "user", "timestamp": 900},
        {"id": "no-time", "role": "assistant"},
    ]});
    assert_eq!(newest_chat_turn(&record), Some(200));
    assert_eq!(newest_chat_turn(&json!({"messages": []})), None);
    assert_eq!(newest_chat_turn(&Value::Null), None);
}

/// Saves the thread on a Claude Code session, with an optional newer chat turn.
fn bind_claude(f: &Fixture, id: &str, turn: Option<&str>) {
    let mut record: Value = f
        .client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap();
    let messages = record["messages"].as_array_mut().unwrap();
    if let Some(text) = turn {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        messages.push(json!({"role": "user", "content": text, "timestamp": now + 1_000}));
    }
    let url = f.client.url("/api/v2/chat-history").unwrap();
    f.client
        .request("POST", &url)
        .send_json(json!({
            "tabId": id, "messages": messages, "backend": "claude",
            "orchestratorSessionIds": {"claude": "fixture-claude-session"},
        }))
        .unwrap();
}

#[gpui::test]
fn thread_view_carries_turns_both_ways_on_one_session(cx: &mut TestAppContext) {
    // The stand-in CLIs only: a resume line never reaches a CLI on the machine.
    let f = Fixture::start_mode(false, "--terminal --cli-shim");
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("thread-view.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    let id = s.read_with(&v, |s, _| match s.active() {
        Some(Tab::Session(id)) => id,
        _ => panic!("a thread opens first"),
    });
    bind_claude(&f, &id, None);
    let resumed = "fixture claude stand-in: --resume fixture-claude-session";
    let pane = |s: &Entity<Shell>, v: &VisualTestContext| {
        s.read_with(v, |s, cx| match &thread(s, cx).unwrap().state {
            State::Open(pane) => Some(pane.clone()),
            _ => None,
        })
    };
    let shows = |pane: &Entity<crate::terminal::Pane>, v: &VisualTestContext, text: &str| {
        pane.read_with(v, |pane, _| pane.grid.lock().unwrap().text().contains(text))
    };
    let history = |f: &Fixture| -> Value {
        f.client
            .get("/api/v2/chat-history", &[("tabId", &id)])
            .unwrap()
    };

    // Terminal to chat: a turn typed into the CLI is in the chat on leaving.
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the stand-in resumed", |v| {
        pane(&s, v).is_some_and(|p| shows(&p, v, resumed))
    });
    let first = pane(&s, &v).unwrap();
    first.update(&mut v, |pane, cx| {
        pane.run_line("hello from the terminal".into(), cx)
    });
    until(&mut v, "the stand-in's reply", |v| {
        shows(&first, v, "stand-in reply")
    });
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the terminal turn in the chat", |v| {
        v.update(|_, cx| crate::shell::toasts::texts(cx))
            .contains(&"1 turn from the terminal".to_owned())
    });
    let record = history(&f);
    let imported: Vec<(&str, &str)> = record["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| {
            m["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("cli-claude-"))
        })
        .map(|m| (m["role"].as_str().unwrap(), m["content"].as_str().unwrap()))
        .collect();
    assert_eq!(
        imported,
        [
            ("user", "hello from the terminal"),
            ("assistant", "stand-in reply")
        ]
    );
    assert_eq!(
        record["orchestratorSessionIds"],
        json!({"claude": "fixture-claude-session"})
    );

    // Chat to terminal: a newer chat turn resumes the CLI again, on the
    // same session, once Reopen has stopped it.
    bind_claude(&f, &id, Some("A turn sent from chat"));
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the newer-turns notice", |v| {
        s.read_with(v, |s, cx| thread(s, cx).unwrap().stale) == Stale::Newer
    });
    click(&mut v, "thread-terminal-reopen");
    until(&mut v, "the stand-in resumed in a new shell", |v| {
        pane(&s, v).is_some_and(|p| p.entity_id() != first.entity_id() && shows(&p, v, resumed))
    });
    let launch = s.read_with(&v, |s, cx| thread(s, cx).unwrap().launch.clone().unwrap());
    assert_eq!(launch.line, "exec claude --resume fixture-claude-session");
    assert_eq!(
        history(&f)["orchestratorSessionIds"],
        json!({"claude": "fixture-claude-session"})
    );
    // Leaving again imports nothing twice.
    let count = history(&f)["messages"].as_array().unwrap().len();
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    settle(&mut v);
    assert_eq!(history(&f)["messages"].as_array().unwrap().len(), count);
}
