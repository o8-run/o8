//! The existing durable bus -> production HTTP handlers -> retained Inbox and sidebar.
//! These tests intentionally use only today's APIs/types; missing behavior fails a UI assertion.
use super::*;

fn oracle(fixture: &Fixture) -> Value {
    serde_json::from_slice(&fs::read(fixture.root.join("oracle.json")).unwrap()).unwrap()
}

fn exchange<'a>(oracle: &'a Value, summary: &str) -> &'a Value {
    oracle["agentExchanges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["summary"] == summary)
        .expect("production bus fixture exchange")
}

fn stored(fixture: &Fixture, exchange: &Value) -> Value {
    fixture
        .client
        .get::<Value>(
            "/api/agents/conversation",
            &[
                ("repo", exchange["repo"].as_str().unwrap()),
                ("limit", "100"),
            ],
        )
        .unwrap()["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == exchange["id"])
        .unwrap()
        .clone()
}

fn unchanged(before: &Value, after: &Value) {
    for field in [
        "participants",
        "turnCount",
        "turnLimit",
        "remainingTurns",
        "lastMessageId",
        "summary",
    ] {
        assert_eq!(before[field], after[field], "Settle/Undo changed {field}");
    }
}

// The test opener omits the maintenance pump. Drive the same shell tick
// that production uses on a data wake before inspecting asynchronous UI state.
fn tick_shell(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| {
        let shell = window.root::<Shell>().flatten().expect("existing shell");
        shell.update(cx, |shell, cx| shell.tick(false, window, cx));
    });
    cx.run_until_parked();
    draw(cx);
}

fn wait_control(cx: &mut gpui::VisualTestContext, selector: &str) {
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        tick_shell(cx);
        if bounds(cx, selector).is_some() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "missing exchange control {selector}: {}",
            inbox_state(cx)
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn wait_status(
    fixture: &Fixture,
    exchange: &Value,
    status: &str,
    cx: &mut gpui::VisualTestContext,
) -> Value {
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        tick_shell(cx);
        let current = stored(fixture, exchange);
        if current["status"] == status {
            return current;
        }
        assert!(
            Instant::now() < deadline,
            "exchange never became {status}: {current}"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

fn open_inbox(
    shell: &Entity<Shell>,
    cx: &mut gpui::VisualTestContext,
) -> Entity<crate::inbox::Inbox> {
    settle_shell(shell, cx);
    // The real right-panel hook owns legacy Inbox migration.
    tick_shell(cx);
    assert!(
        shell.read_with(cx, |shell, _| {
            shell
                .state
                .workspaces
                .values()
                .all(|workspace| !workspace.tabs.contains(&Tab::Inbox))
        }),
        "legacy Inbox tab did not migrate on the production shell tick"
    );
    let already_open = shell.read_with(cx, |shell, _| {
        shell.panel_front_key().is_some_and(|key| {
            key.ends_with("|Inbox") && matches!(shell.content.get(&key), Some(Content::Inbox(_)))
        })
    });
    if !already_open {
        // Migration can leave no active central surface. Focus the existing
        // global palette owner, then navigate through the real command UI.
        if !shell.read_with(cx, |shell, _| shell.palette) {
            cx.update(|window, cx| shell.read(cx).focus.focus(window));
            cx.simulate_keystrokes("ctrl-k");
        }
        tick_shell(cx);
        assert!(
            shell.read_with(cx, |shell, _| shell.palette),
            "the real command palette must open"
        );
        cx.simulate_keystrokes("i n b o x");
        assert_eq!(
            shell.read_with(cx, |shell, _| {
                shell
                    .commands()
                    .iter()
                    .map(|command| command.label(&shell.sessions))
                    .collect::<Vec<_>>()
            }),
            vec!["Open Inbox"]
        );
        cx.simulate_keystrokes("enter");
    }
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        tick_shell(cx);
        if shell.read_with(cx, |shell, cx| {
            shell.panel_front_key().is_some_and(|key| {
                key.ends_with("|Inbox")
                    && match shell.content.get(&key) {
                        Some(Content::Inbox(inbox)) => {
                            inbox.read(cx).loaded && !inbox.read(cx).loading
                        }
                        _ => false,
                    }
            })
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Inbox panel did not open and load: {}",
            inbox_state(cx)
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let panel = inbox_panel(shell, cx);
    wait_control(cx, "inbox-agent-exchanges-group");
    panel
}

#[gpui::test]
fn agent_exchanges_open_exact_transcripts_and_sidebar_selects_one_retained_inbox(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let expected = oracle(&fixture);
    let first = exchange(&expected, "Keep the exchange summary.");
    let second = exchange(&expected, "Separate same-peer exchange.");
    let id = first["id"].as_str().unwrap();
    let repo = first["repo"].as_str().unwrap().to_owned();
    let mut state = State {
        selected: Some(repo.clone()),
        ..Default::default()
    };
    state.workspaces.insert(
        repo,
        Workspace {
            tabs: vec![Tab::Inbox],
            ..Default::default()
        },
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("exchanges-navigation.json"),
        state,
        cx,
    );
    let cx = &mut visual;
    let panel = open_inbox(&shell, cx);
    for item in [first, second] {
        wait_control(
            cx,
            &format!("inbox-exchange-active-{}", item["id"].as_str().unwrap()),
        );
    }
    let open = format!("inbox-exchange-open-{id}");
    wait_control(cx, &open);
    click(cx, &open);
    let transcript = expected["agentExchangeMessages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["conversationId"] == first["id"])
        .collect::<Vec<_>>();
    assert_eq!(transcript.len(), 2);
    let mut previous_y = None;
    for message in transcript {
        let selector = format!("inbox-exchange-message-{}", message["id"].as_str().unwrap());
        wait_control(cx, &selector);
        let y = bounds(cx, &selector).unwrap().origin.y;
        if let Some(previous) = previous_y {
            assert!(y > previous, "bus transcript sequence must survive");
        }
        previous_y = Some(y);
    }
    click(cx, "sidebar-view");
    click(cx, "sidebar-view-inbox");
    let sidebar = format!("sidebar-agent-exchange-{id}");
    wait_control(cx, &sidebar);
    click(cx, &sidebar);
    assert!(
        inbox_panel(&shell, cx) == panel,
        "sidebar exchange selection must reuse the retained right-panel Inbox"
    );
    shell.read_with(cx, |shell, _| {
        assert_eq!(
            shell
                .content
                .keys()
                .filter(|key| key.starts_with("panel|") && key.ends_with("|Inbox"))
                .count(),
            1
        );
        assert!(
            shell
                .state
                .workspaces
                .values()
                .flat_map(|workspace| &workspace.tabs)
                .all(|tab| {
                    !matches!(tab, Tab::Session(session) if session == id) && tab != &Tab::Inbox
                }),
            "a bus ID must never become a Session tab, and legacy Inbox tabs must migrate"
        );
    });
    // The bus remains the only exchange identity; opening it sends nothing.
    unchanged(first, &stored(&fixture, first));
    assert_eq!(stored(&fixture, first)["status"], "open");
}

#[gpui::test]
fn agent_exchange_settle_undo_and_external_close_preserve_bus_state(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let expected = oracle(&fixture);
    let first = exchange(&expected, "Keep the exchange summary.");
    let second = exchange(&expected, "Separate same-peer exchange.");
    let id = first["id"].as_str().unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("exchanges-settle.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    let panel = open_inbox(&shell, cx);
    let final_exchange = expected["agentExchanges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["status"] == "closed")
        .unwrap();
    let final_id = final_exchange["id"].as_str().unwrap();
    assert!(
        bounds(cx, &format!("inbox-exchange-open-{final_id}")).is_none(),
        "Settled begins collapsed"
    );
    let settle = format!("inbox-exchange-settle-{id}");
    wait_control(cx, &settle);
    click(cx, &settle);
    let closed = wait_status(&fixture, first, "closed", cx);
    unchanged(first, &closed);
    click(cx, "inbox-exchanges-settled");
    wait_control(cx, &format!("inbox-exchange-settled-{id}"));
    cx.update(|window, cx| panel.read(cx).focus(window));
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    let restored = wait_status(&fixture, first, "open", cx);
    unchanged(first, &restored);
    let transcript = fixture
        .client
        .get::<Value>(
            "/api/agents/conversation",
            &[("repo", first["repo"].as_str().unwrap()), ("id", id)],
        )
        .unwrap();
    assert_eq!(
        transcript["messages"].as_array().unwrap().len(),
        2,
        "Undo cannot append or redeliver a bus message"
    );
    let other_id = second["id"].as_str().unwrap();
    ureq::post(&format!("{}/api/agents/conversation", fixture.origin))
        .set("Authorization", "Bearer fixture-inbox-operator-credential")
        .send_json(serde_json::json!({"repo":second["repo"], "id":other_id, "action":"close", "summary":second["summary"]}))
        .unwrap();
    click(cx, "inbox-refresh");
    wait_control(cx, &format!("inbox-exchange-settled-{other_id}"));
    unchanged(second, &wait_status(&fixture, second, "closed", cx));
    cx.update(|window, cx| panel.read(cx).focus(window));
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    cx.run_until_parked();
    assert_eq!(
        stored(&fixture, second)["status"],
        "closed",
        "an external close has no session-local manual Undo receipt"
    );
    assert_eq!(
        stored(&fixture, final_exchange)["status"],
        "closed",
        "final closures must not be reopened implicitly"
    );
    assert!(bounds(cx, &format!("inbox-exchange-settle-{final_id}")).is_none());
}
