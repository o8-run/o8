//! Production fixture routes -> shell palette -> GPUI controls -> persisted approvals.
use super::*;
use crate::shell::test_support::{draw, open};
use gpui::TestAppContext;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command as Process, Stdio},
    time::Instant,
};

struct Fixture {
    server: Child,
    client: Client,
    root: PathBuf,
    origin: String,
}
impl Fixture {
    fn new() -> Self {
        Self::start(false)
    }
    fn start(empty: bool) -> Self {
        Self::start_mode(empty, false)
    }
    fn start_mode(empty: bool, plan: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-inbox-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        let alias = {
            let target = root.join("fixture-temp");
            fs::create_dir(&target).unwrap();
            let alias = root.join("temp-alias");
            std::os::unix::fs::symlink(target, &alias).unwrap();
            alias
        };
        let mut command = Process::new("node");
        #[cfg(unix)]
        command.env("TMPDIR", &alias);
        let mut server = command
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--shell",
                "--inbox",
            ])
            .args(if empty { vec!["--inbox-empty"] } else { vec![] })
            .args(if plan { vec!["--inbox-plan"] } else { vec![] })
            .env("O8_NEXT_API_TOKEN", "fixture-inbox-operator-credential")
            .env("O8_NEXT_INBOX_ORACLE", root.join("oracle.json"))
            .env("O8_NEXT_INBOX_PLAN_FIXTURE", root.join("plan.json"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let origin = BufReader::new(server.stdout.take().unwrap())
            .lines()
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("production Inbox fixture host must start");
        let client =
            Client::authenticated(&origin, Some("fixture-inbox-operator-credential".into()))
                .unwrap();
        Self {
            server,
            client,
            root,
            origin,
        }
    }
    fn post(&self, id: &str, action: &str) -> Value {
        ureq::post(&format!("{}/api/panel/approvals", self.origin))
            .set("Authorization", "Bearer fixture-inbox-operator-credential")
            .send_json(serde_json::json!({"action":action,"id":id}))
            .unwrap()
            .into_json()
            .unwrap()
    }
    fn records(&self) -> Vec<Value> {
        self.client
            .get::<Value>(
                "/api/panel/approvals",
                &[("status", "all"), ("scope", "all")],
            )
            .unwrap()["approvals"]
            .as_array()
            .unwrap()
            .clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.server.try_wait().ok().flatten().is_none() {
            let _ = Process::new("kill")
                .args(["-TERM", &self.server.id().to_string()])
                .status();
            let _ = self.server.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn panel(shell: &Shell) -> &Content {
    let scope = format!("panel|{}|", shell.state.selected.as_deref().unwrap_or(""));
    assert!(!shell.current().is_some_and(|w| w.tabs.contains(&Tab::Inbox)), "Inbox belongs in the panel, not the main tab strip");
    shell.content.iter().find_map(|(key, content)| {
        (key.starts_with(&scope) && matches!(content, Content::Inbox(_))).then_some(content)
    }).expect("current workspace Inbox panel")
}

fn bounds(cx: &mut gpui::VisualTestContext, selector: &str) -> Option<Bounds<gpui::Pixels>> {
    cx.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
}
fn click(cx: &mut gpui::VisualTestContext, selector: &str) {
    draw(cx);
    if selector.starts_with("inbox-approve-")
        || selector.starts_with("inbox-reject-")
        || selector.starts_with("inbox-open-")
    {
        for _ in 0..5 {
            let target = bounds(cx, selector).expect("card action");
            let viewport = bounds(cx, "inbox-cards").expect("scroll viewport");
            if viewport.contains(&target.center()) {
                break;
            }
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: viewport.center(),
                delta: gpui::ScrollDelta::Pixels(point(
                    px(0.),
                    viewport.center().y - target.center().y,
                )),
                modifiers: Default::default(),
                touch_phase: gpui::TouchPhase::Moved,
            });
            draw(cx);
        }
    }
    let bounds =
        bounds(cx, selector).unwrap_or_else(|| panic!("missing native control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

fn tab_to_action(shell: &Entity<Shell>, cx: &mut gpui::VisualTestContext, id: &str, approve: bool) {
    let selector = format!(
        "inbox-focus-{}-{id}",
        if approve { "approve" } else { "reject" }
    );
    for _ in 0..24 {
        cx.simulate_keystrokes("tab");
        draw(cx);
        let focused = shell.update_in(cx, |shell, window, cx| {
            match panel(shell) {
                Content::Inbox(inbox) => {
                    inbox.read(cx).action_focus[id][usize::from(approve)].is_focused(window)
                }
                _ => false,
            }
        });
        if focused {
            assert!(
                bounds(cx, &selector).is_some(),
                "focused button must paint its focus ring"
            );
            return;
        }
    }
    panic!("approval action must be reachable by Tab and show a visible focus ring");
}

#[gpui::test]
fn inbox_keyboard_buttons_activate_enter_space_and_skip_disabled(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let records = fixture.records();
    let id = |title: &str| {
        records
            .iter()
            .find(|record| record["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("keyboard.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let active_before_inbox = shell.read_with(cx, |s, _| s.active());
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    click(cx, "inbox-view-approvals");
    tab_to_action(&shell, cx, &id("Native approve"), true);
    cx.simulate_keystrokes("right");
    draw(cx);
    cx.simulate_keystrokes("left");
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, cx| {
            match panel(s) {
                Content::Inbox(inbox) => inbox.read(cx).lane,
                _ => usize::MAX,
            }
        }),
        2,
        "view keys must keep working after removing the focused approval button"
    );
    tab_to_action(&shell, cx, &id("Native approve"), true);
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|record| record["id"] == id("Native approve"))
            .unwrap()["status"],
        "approved"
    );
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        active_before_inbox,
        "Enter on a decision must not open its session"
    );
    tab_to_action(&shell, cx, &id("Native reject"), false);
    cx.simulate_keystrokes("space");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|record| record["id"] == id("Native reject"))
            .unwrap()["status"],
        "rejected"
    );
    for _ in 0..12 {
        cx.simulate_keystrokes("tab");
        draw(cx);
        for action in ["approve", "reject"] {
            assert!(
                bounds(
                    cx,
                    &format!("inbox-focus-{action}-{}", id("Unconfirmed continuation"))
                )
                .is_none()
            );
        }
    }
    cx.simulate_keystrokes("shift-tab");
    draw(cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), active_before_inbox);
}

#[gpui::test]
fn inbox_plan_session_header_preserves_desktop_authority_and_continuation(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, true);
    let plan: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("plan.json")).unwrap()).unwrap();
    let id = plan["nativeId"].as_str().unwrap();
    let file = PathBuf::from(plan["file"].as_str().unwrap());
    let before = fixture
        .records()
        .into_iter()
        .find(|record| record["id"] == id)
        .unwrap();
    assert!(
        fixture
            .client
            .inbox_decision(id, true)
            .unwrap_err()
            .contains("HTTP 401")
    );
    for (session, expected) in [
        ("invalid-session", 401),
        (plan["expired"].as_str().unwrap(), 401),
    ] {
        let response = ureq::post(&format!("{}/api/panel/approvals", fixture.origin))
            .set("Authorization", "Bearer fixture-inbox-operator-credential")
            .set("x-clerk-session-token", session)
            .send_json(serde_json::json!({"action":"approve","id":id}))
            .unwrap_err();
        assert!(matches!(response, ureq::Error::Status(status, _) if status == expected));
    }
    for field in ["wrongOwner", "wrongSession"] {
        let response = ureq::post(&format!("{}/api/panel/approvals", fixture.origin))
            .set("Authorization", "Bearer fixture-inbox-operator-credential")
            .set("x-clerk-session-token", plan[field].as_str().unwrap())
            .send_json(serde_json::json!({"action":"approve","id":id}))
            .unwrap_err();
        assert!(matches!(response, ureq::Error::Status(401 | 403 | 409, _)));
    }
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|record| record["id"] == id)
            .unwrap(),
        &before
    );
    assert!(
        !file.exists(),
        "refused identities must not execute the tool"
    );
    let desktop: Value = ureq::post(&format!("{}/api/panel/approvals", fixture.origin))
        .set("Authorization", "Bearer fixture-inbox-operator-credential")
        .set("x-clerk-session-token", plan["valid"].as_str().unwrap())
        .send_json(serde_json::json!({"action":"approve","id":plan["desktopId"]}))
        .unwrap()
        .into_json()
        .unwrap();
    assert_eq!(desktop["approval"]["status"], "approved");
    assert!(
        file.exists(),
        "desktop fixture continuation failed: {}",
        desktop["note"]
    );
    fs::remove_file(&file).unwrap();
    let native = fixture
        .client
        .clone()
        .with_desktop_session(Some(plan["valid"].as_str().unwrap().into()))
        .unwrap();
    let worker = Client::authenticated(
        &fixture.origin,
        Some("fixture-inbox-worker-credential".into()),
    )
    .unwrap()
    .with_desktop_session(Some(plan["valid"].as_str().unwrap().into()))
    .unwrap();
    assert!(
        worker
            .inbox_decision(id, true)
            .unwrap_err()
            .contains("HTTP 403")
    );
    assert!(
        !file.exists(),
        "the worker must not execute the approved tool"
    );
    let desktop_record = fixture
        .records()
        .into_iter()
        .find(|record| record["id"] == plan["desktopId"])
        .unwrap();
    let (shell, mut visual) = open(
        native,
        fixture.root.join("plan-shell.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let active_before_inbox = shell.read_with(cx, |s, _| s.active());
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    click(cx, "inbox-view-approvals");
    click(cx, &format!("inbox-approve-{id}"));
    let after = fixture
        .records()
        .into_iter()
        .find(|record| record["id"] == id)
        .unwrap();
    assert_eq!(
        after["status"], "approved",
        "native plan approval must send the same verified desktop session header"
    );
    for field in ["action", "actor", "continuationStatus"] {
        assert_eq!(
            after["resolution"][field],
            desktop_record["resolution"][field]
        );
    }
    assert_eq!(after["resolution"]["continuationStatus"], "completed");
    assert_eq!(fs::read_to_string(&file).unwrap(), "bounded test edit");
    assert_eq!(shell.read_with(cx, |s, _| s.active()), active_before_inbox);
}

#[gpui::test]
fn inbox_cards_counts_statuses_and_approval_match_desktop_routes(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let expected: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("oracle.json")).unwrap()).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("shell.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let active_before_inbox = shell.read_with(cx, |s, _| s.active());
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| { panel(s); s.active() }),
        active_before_inbox
    );
    let mut counts = vec![];
    for lane in ["replies", "contributions", "approvals", "agents", "history"] {
        let cards = expected[lane].as_array().unwrap();
        counts.push(cards.len());
        assert!(!cards.is_empty(), "fixture must exercise {lane}");
        click(cx, &format!("inbox-view-{lane}"));
        assert!(bounds(cx, &format!("inbox-count-{lane}-{}", cards.len())).is_some());
        let mut last_y = None;
        for card in cards {
            let id = card["id"].as_str().unwrap();
            let card_bounds =
                bounds(cx, &format!("inbox-card-{id}")).expect("desktop card must paint in native");
            if let Some(y) = last_y {
                assert!(card_bounds.origin.y > y, "desktop route order must survive");
            }
            last_y = Some(card_bounds.origin.y);
            for field in ["status", "source"] {
                assert!(
                    bounds(
                        cx,
                        &format!("inbox-{field}-{id}-{}", card[field].as_str().unwrap())
                    )
                    .is_some(),
                    "native {field} differs for {id}"
                );
            }
        }
    }
    click(cx, "inbox-view-approvals");
    let records = fixture.records();
    let id = |title: &str| {
        records.iter().find(|a| a["title"] == title).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let native = id("Native approve");
    let desktop = id("Desktop approve");
    let rejected = id("Native reject");
    fixture.post(&desktop, "approve");
    click(cx, &format!("inbox-approve-{native}"));
    click(cx, &format!("inbox-reject-{rejected}"));
    let after = fixture.records();
    let record = |id: &str| after.iter().find(|a| a["id"] == id).unwrap();
    assert_eq!(record(&native)["status"], "approved");
    assert_eq!(record(&rejected)["status"], "rejected");
    // Compare durable decision, principal and continuation outcome, excluding generated identity/time.
    for field in ["action", "actor", "continuationStatus", "note"] {
        assert_eq!(
            record(&native)["resolution"][field],
            record(&desktop)["resolution"][field]
        );
    }
    let audit = |id: &str| {
        record(id)["audit"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| {
                (
                    event["type"].clone(),
                    event["actor"].clone(),
                    event["note"].clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(audit(&native), audit(&desktop));
    assert!(record(&native)["resolvedAt"].is_number());
    assert_eq!(record(&native)["resolution"]["actor"], "desktop");
    let after_counts = shell.read_with(cx, |s, cx| {
        match panel(s) {
            Content::Inbox(inbox) => inbox
                .read(cx)
                .cards
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            _ => panic!("Inbox"),
        }
    });
    assert_eq!(after_counts, vec![1, 2, 2, 4, 3]);
    let uncertain = id("Unconfirmed continuation");
    let before_uncertain = record(&uncertain).clone();
    click(cx, &format!("inbox-approve-{uncertain}"));
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|a| a["id"] == uncertain)
            .unwrap(),
        &before_uncertain
    );
    println!(
        "Inbox parity counts before={counts:?} after={after_counts:?}; native approved=1 rejected=1; desktop approved=1; durable decision/audit match"
    );
    // The native transport uses the same middleware and cannot promote a worker to operator.
    let worker = Client::authenticated(
        &fixture.origin,
        Some("fixture-inbox-worker-credential".into()),
    )
    .unwrap();
    let error = worker
        .inbox_decision(&id("Worker denied"), true)
        .unwrap_err();
    assert!(
        error.contains("operator-only") || error.contains("HTTP 403"),
        "worker refusal: {error}"
    );
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|a| a["id"] == id("Worker denied"))
            .unwrap()["status"],
        "pending"
    );
}

#[gpui::test]
fn inbox_opens_related_session_and_pull_request_and_restores(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let expected: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("oracle.json")).unwrap()).unwrap();
    let file = fixture.root.join("navigation.json");
    let workspace = fixture.client.sessions().unwrap()[0]
        .repo_path
        .clone()
        .unwrap();
    let mut initial = State {
        selected: Some(workspace.clone()),
        ..Default::default()
    };
    let mut saved_workspace = Workspace {
        tabs: vec![Tab::Session("thoughts-review".into())],
        ..Default::default()
    };
    saved_workspace
        .selections
        .insert("thoughts-review".into(), "thoughts-long".into());
    initial.workspaces.insert(workspace, saved_workspace);
    initial.save(&file).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let started = Instant::now();
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    let open_ms = started.elapsed().as_secs_f64() * 1000.;
    click(cx, "inbox-view-contributions");
    let pr = expected["contributions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|card| card["id"].as_str().unwrap().contains(":pr:"))
        .unwrap();
    click(cx, &format!("inbox-open-{}", pr["id"].as_str().unwrap()));
    assert_eq!(
        cx.cx.opened_url().as_deref(),
        Some("https://github.com/example/inbox-fixture/pull/42")
    );
    click(cx, "inbox-view-agents");
    click(
        cx,
        &format!(
            "inbox-open-{}",
            expected["agents"][0]["id"].as_str().unwrap()
        ),
    );
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session("thoughts-review".into()))
    );
    assert_eq!(
        shell.update_in(cx, |s, window, cx| {
            match s
                .content
                .get(&s.key(&Tab::Session("thoughts-review".into())))
                .unwrap()
            {
                Content::Session(session) => session.read(cx).shell_selection(window, cx).0,
                _ => None,
            }
        }),
        Some("thoughts-review".into()),
        "the related session must replace a stale saved sidebar selection"
    );
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s
            .current()
            .unwrap()
            .tabs
            .iter()
            .filter(|t| **t == Tab::Inbox)
            .count()),
        0
    );
    shell.read_with(cx, |s, _| { panel(s); });
    for (w, h) in [(900., 700.), (1680., 1050.)] {
        let handle = cx.update(|window, _| window.window_handle());
        cx.cx.simulate_window_resize(handle, size(px(w), px(h)));
        draw(cx);
        let area = bounds(cx, "inbox-cards").unwrap();
        assert!(area.origin.x >= px(0.) && area.right() <= px(w), "Inbox cards {area:?} must fit {w}x{h}");
        for (lane, _) in crate::inbox::VIEWS {
            assert!(bounds(cx, &format!("inbox-view-{lane}")).is_some());
        }
    }
    assert!(cx.simulate_close());
    let saved = State::load(&file).unwrap();
    let (restored, mut restored_cx) = open(fixture.client.clone(), file, saved, &mut cx.cx);
    restored_cx.run_until_parked();
    draw(&mut restored_cx);
    restored.update_in(&mut restored_cx, |s, window, cx| s.tick(false, window, cx));
    restored_cx.run_until_parked();
    draw(&mut restored_cx);
    assert_eq!(
        restored.read_with(&restored_cx, |s, _| { panel(s); s.active() }),
        Some(Tab::Session("thoughts-review".into()))
    );
    assert!(bounds(&mut restored_cx, "inbox-view-replies").is_some());
    println!(
        "Inbox palette to loaded CPU scene: {open_ms:.2} ms; compact=900x700 wide=1680x1050; restored Inbox panels=1"
    );
}

#[gpui::test]
fn inbox_empty_and_server_error_never_claim_a_false_clean_state(cx: &mut TestAppContext) {
    let mut fixture = Fixture::start(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("empty.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    assert!(
        shell.read_with(cx, |s, _| s.workspaces.is_empty()),
        "the empty Inbox must also work before any session is saved"
    );
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    for (lane, _) in crate::inbox::VIEWS {
        click(cx, &format!("inbox-view-{lane}"));
        assert!(bounds(cx, "inbox-empty").is_some());
        assert!(bounds(cx, &format!("inbox-count-{lane}-0")).is_some());
    }
    cx.simulate_keystrokes("ctrl-alt-b");
    assert!(shell.read_with(cx, |s, _| s.active().is_none()));
    assert!(!State::load(&fixture.root.join("empty.json")).unwrap().workspaces[""].surfaces.inbox.panel_inbox_open);
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        State::load(&fixture.root.join("empty.json"))
            .unwrap()
            .workspaces[""]
            .tabs,
        Vec::<Tab>::new()
    );
    assert!(State::load(&fixture.root.join("empty.json")).unwrap().workspaces[""].surfaces.inbox.panel_inbox_open);
    let _ = Process::new("kill")
        .args(["-TERM", &fixture.server.id().to_string()])
        .status();
    fixture.server.wait().unwrap();
    click(cx, "inbox-refresh");
    assert!(shell.read_with(
        cx,
        |s, cx| match panel(s) {
            Content::Inbox(inbox) =>
                inbox.read(cx).error().is_some() && inbox.read(cx).errors[2].is_some(),
            _ => false,
        }
    ));
    assert!(bounds(cx, "inbox-error").is_some());
    // Debug bounds persist in TestAppContext after removal; inspect current state too.
    shell.read_with(cx, |s, cx| {
        match panel(s) {
            Content::Inbox(inbox) => assert!(
                !inbox.read(cx).loading
                    && inbox.read(cx).loaded
                    && inbox.read(cx).error().is_some()
            ),
            _ => panic!("Inbox"),
        }
    });
}
