use super::thread_view::{NO_SESSION, State, Views, resume_line, thread};
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
    v.simulate_keystrokes("ctrl-alt-v");
    settle(&mut v);
    assert!(s.read_with(&v, |s, cx| !thread(s, cx).unwrap().terminal));
    assert!(v.debug_bounds("thread-terminal-notice").is_none());

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
    // Opening it again adopts that shell and types nothing into it.
    s.update_in(&mut v, |s, window, cx| {
        s.features.get::<Views>().threads.clear();
        // As closing a tab does, the shell hands focus back.
        s.restore_focus(window, cx);
    });
    drop(pane);
    settle(&mut v);
    v.simulate_keystrokes("ctrl-alt-v");
    until(&mut v, "the running shell adopted", |v| {
        s.read_with(v, |s, cx| {
            thread(s, cx).is_some_and(|t| matches!(&t.state, State::Open(p) if p.read(cx).ready))
        })
    });
    assert!(s.read_with(&v, |s, cx| thread(s, cx).unwrap().adopted));
    assert!(v.debug_bounds("thread-terminal-view").is_some());
}
