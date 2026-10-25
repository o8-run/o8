//! Real shell controls -> Client -> production HTTP handlers -> owned fixture storage.
use super::*;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, Command as Process, Stdio},
    time::Instant,
};

struct Fixture {
    server: Child,
    client: Client,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self::start(false)
    }
    fn start(worker: bool) -> Self {
        Self::with_flags(worker, &[])
    }
    fn with_flags(worker: bool, flags: &[&str]) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-issues-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut command = Process::new("node");
        if flags.contains(&"--issues-advancing-clock") {
            command.args(["--import", "./scripts/next/surfaces/issues/advancing-clock.mjs"]);
        }
        command
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--issues",
                "--composer",
                "--shell",
            ]);
        if worker {
            command.arg("--worker");
        }
        command.args(flags);
        let mut server = command
            .env("O8_NEXT_API_TOKEN", "fixture-next-issues-operator")
            .stdin(Stdio::piped())
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
            .expect("fixture origin");
        Self {
            server,
            root,
            client: Client::authenticated(&origin, Some("fixture-next-issues-operator".into()))
                .unwrap(),
        }
    }
    fn command(&mut self, command: &str) {
        writeln!(self.server.stdin.as_mut().unwrap(), "{command}").unwrap();
    }
}

#[path = "issue_review_tests.rs"]
mod review_tests;

#[gpui::test]
fn issues_worker_receives_linked_context_through_stream(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (shell, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-view-7");
    click(cx, "issue-work");
    wait(cx, "issue-worker");
    let deadline = Instant::now() + Duration::from_secs(35);
    while Instant::now() < deadline {
        draw(cx);
        let history = fixture.client.history("thoughts-composer-first").unwrap();
        if history.transcript.iter().any(|entry| {
            entry.role == "assistant" && entry.text.contains("Linked issue context received")
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let state = shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Issues(i) => i.read(cx).worker_state(cx),
            _ => Value::Null,
        }
    });
    let sessions = fixture.client.sessions().unwrap();
    let queue = fixture
        .client
        .queue(
            sessions
                .iter()
                .find(|s| s.id == "thoughts-composer-first")
                .unwrap(),
        )
        .unwrap();
    let statuses = queue["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["status"].clone())
        .collect::<Vec<_>>();
    panic!(
        "real fixture worker must receive issue context and persist its streamed reply: {state}; {statuses:?}"
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Process::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
}
fn scene(cx: &mut VisualTestContext) -> Value {
    cx.update(|window, cx| {
        let shell = window.root::<Shell>().unwrap().unwrap();
        let shell = shell.read(cx);
        match shell
            .active()
            .and_then(|t| shell.content.get(&shell.key(&t)))
        {
            Some(Content::Issues(issues)) => issues.read(cx).snapshot(),
            _ => Value::Null,
        }
    })
}
fn wait(cx: &mut VisualTestContext, selector: &'static str) {
    for _ in 0..40 {
        draw(cx);
        if scene(cx)["controls"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i == selector))
        {
            return;
        }
    }
    panic!("real control did not reach CPU paint: {selector}");
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    wait(cx, selector);
    let center = cx.debug_bounds(selector).unwrap().center();
    cx.simulate_click(center, gpui::Modifiers::default());
    draw(cx);
}
fn input(cx: &mut VisualTestContext, selector: &'static str, text: &str) {
    click(cx, selector);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input(text);
    draw(cx);
}
fn open(fixture: &Fixture, cx: &mut TestAppContext) -> (Entity<Shell>, VisualTestContext, f64) {
    let handle = cx.update(|cx| {
        view::open_window(
            fixture.client.clone(),
            fixture.root.join("shell.json"),
            State::default(),
            true,
            cx,
        )
    });
    let shell = handle.root(cx).unwrap();
    let mut visual = VisualTestContext::from_window(handle.into(), cx);
    for _ in 0..40 {
        draw(&mut visual);
        if shell.read_with(&visual, |s, _| s.connected) {
            break;
        }
    }
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("i s s u e s");
    let start = Instant::now();
    visual.simulate_keystrokes("enter");
    wait(&mut visual, "issue-ready");
    (shell, visual, start.elapsed().as_secs_f64() * 1000.)
}

#[gpui::test]
fn issues_view_search_link_clear_and_worker_task(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_shell, mut visual, open_ms) = open(&fixture, cx);
    let cx = &mut visual;
    input(cx, "issue-search", "unmatched");
    wait(cx, "issue-empty");
    input(cx, "issue-search", "8");
    click(cx, "issue-open-number");
    wait(cx, "issue-detail-8");
    click(cx, "issue-back");
    input(cx, "issue-search", "7");
    wait(cx, "issue-view-7");
    assert!(
        cx.debug_bounds("issue-view-8").is_none(),
        "closed issues are excluded from the picker"
    );
    click(cx, "issue-link-7");
    wait(cx, "issue-linked-7");
    click(cx, "issue-open-linked");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/fixture/alpha/issues/7")
    );
    click(cx, "issue-clear");
    wait(cx, "issue-unlinked");
    click(cx, "issue-view-7");
    wait(cx, "issue-detail-7");
    click(cx, "issue-github");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/fixture/alpha/issues/7")
    );
    click(cx, "issue-work");
    wait(cx, "issue-worker");
    // Work on issue goes through the existing native composer queue. Read its
    // durable receipt through the production route, with canonical workspace identity.
    let sessions = fixture.client.sessions().unwrap();
    let worker = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap();
    let mut persisted = Value::Null;
    for _ in 0..40 {
        draw(cx);
        persisted = fixture.client.queue(worker).unwrap();
        if persisted["items"].as_array().unwrap().iter().any(|i| {
            i["payload"]["wireMessage"]
                .as_str()
                .unwrap_or("")
                .contains("Linked GitHub issue #7 in fixture/alpha")
        }) {
            break;
        }
    }
    let item = persisted["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| {
            i["payload"]["wireMessage"]
                .as_str()
                .unwrap_or("")
                .contains("Linked GitHub issue #7 in fixture/alpha")
        })
        .expect("issue context persisted in worker task");
    assert!(
        item["payload"]["wireMessage"]
            .as_str()
            .unwrap()
            .contains("Issue fixture context.")
    );
    assert_eq!(
        fs::canonicalize(item["repoPath"].as_str().unwrap()).unwrap(),
        fs::canonicalize(worker.repo_path.as_ref().unwrap()).unwrap()
    );
    println!(
        "O8_NEXT_ISSUES_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene; no compositor", "openToFirstFrameMs":open_ms})
    );
}

#[gpui::test]
fn issues_create_enhance_preview_labels_and_success(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-new");
    click(cx, "issue-create");
    wait(cx, "issue-error");
    input(cx, "issue-title", "Rough idea");
    input(cx, "issue-body", "Details");
    input(cx, "issue-label", " BUG ");
    cx.simulate_keystrokes("enter");
    draw(cx);
    wait(cx, "issue-label-0");
    input(cx, "issue-label", "bug");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(
        !scene(cx)["controls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i == "issue-label-1")
    );
    input(cx, "issue-label", "temporary");
    cx.simulate_keystrokes("enter");
    wait(cx, "issue-label-1");
    cx.simulate_keystrokes("backspace");
    draw(cx);
    assert!(
        !scene(cx)["controls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i == "issue-label-1")
    );
    click(cx, "issue-label-0");
    cx.simulate_keystrokes("escape");
    wait(cx, "issue-search");
    click(cx, "issue-new");
    click(cx, "issue-enhance");
    wait(cx, "issue-enhanced");
    click(cx, "issue-preview");
    wait(cx, "issue-preview-body");
    click(cx, "issue-preview");
    click(cx, "issue-create");
    wait(cx, "issue-created-9");
    let detail: Value = fixture
        .client
        .get("/api/panel/issues/9", &[("repo", "fixture/alpha")])
        .unwrap();
    assert_eq!(detail["issue"]["title"], "Enhanced fixture");
    assert_eq!(detail["issue"]["labels"][0]["name"], "bug");
}

#[gpui::test]
fn issues_errors_retry_stale_and_account_switch(cx: &mut TestAppContext) {
    let mut fixture = Fixture::new();
    let (shell, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-view-7");
    wait(cx, "issue-detail-7");
    fixture.command("detail-error");
    click(cx, "issue-retry");
    wait(cx, "issue-error");
    wait(cx, "issue-detail-7"); // Failed refresh retains last successful detail.
    fixture.command("recover");
    click(cx, "issue-retry");
    wait(cx, "issue-ready");
    click(cx, "issue-back");
    click(cx, "issue-repo-1");
    wait(cx, "issue-view-17");
    let snapshot = shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Issues(i) => i.read(cx).snapshot(),
            _ => Value::Null,
        }
    });
    assert_eq!(snapshot["repo"], "fixture/beta");
    assert_eq!(snapshot["issues"], json!([17]));
    assert!(
        !snapshot["controls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i == "issue-view-7"),
        "switching repositories cannot paint the prior account's issues"
    );
    click(cx, "issue-new");
    input(cx, "issue-title", "Refused");
    fixture.command("mutation-error");
    click(cx, "issue-enhance");
    wait(cx, "issue-error");
    click(cx, "issue-create");
    wait(cx, "issue-error");
    wait(cx, "issue-title"); // Draft stays editable after a server refusal.
    input(cx, "issue-title", "Corrected after confirmed refusal");
    fixture.command("recover");
    click(cx, "issue-create");
    wait(cx, "issue-created-9");
    let detail: Value = fixture
        .client
        .get("/api/panel/issues/9", &[("repo", "fixture/beta")])
        .unwrap();
    assert_eq!(
        detail["issue"]["title"],
        "Corrected after confirmed refusal"
    );
}

#[gpui::test]
fn issues_interaction_frames_and_missing_checkout_refusal(cx: &mut TestAppContext) {
    let fixture = Fixture::with_flags(false, &["--issues-advancing-clock"]);
    let (_, mut visual, open_ms) = open(&fixture, cx);
    let cx = &mut visual;
    let mut frames = vec![];
    for _ in 0..20 {
        let start = Instant::now();
        input(cx, "issue-search", "7");
        frames.push(start.elapsed().as_secs_f64() * 1000.);
        input(cx, "issue-search", "");
    }
    click(cx, "issue-repo-2");
    wait(cx, "issue-ready");
    click(cx, "issue-view-7");
    wait(cx, "issue-checkout-missing");
    assert!(
        cx.debug_bounds("issue-work").is_none(),
        "a missing checkout cannot launch a worker task"
    );
    println!(
        "O8_NEXT_ISSUES_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene; no compositor", "openToFirstFrameMs":open_ms, "interactionToFrameMs":frames})
    );
}

#[gpui::test]
fn issues_link_follows_worker_selection(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-link-7");
    click(cx, "issue-task-composer");
    wait(cx, "issue-worker");
    let center = cx.debug_bounds("composer-input").unwrap().center();
    cx.simulate_click(center, gpui::Modifiers::default());
    cx.simulate_keystrokes("tab down");
    wait(cx, "issue-unlinked");
    cx.simulate_keystrokes("escape");
    click(cx, "issue-link-7");
    click(cx, "issue-task-composer");
    let center = cx.debug_bounds("composer-input").unwrap().center();
    cx.simulate_click(center, gpui::Modifiers::default());
    cx.simulate_input("Retained worker draft");
    cx.simulate_keystrokes("escape");
    click(cx, "issue-view-7");
    click(cx, "issue-work");
    wait(cx, "issue-error");
    let state = cx.update(|window, cx| {
        let shell = window.root::<Shell>().unwrap().unwrap();
        let shell = shell.read(cx);
        match shell
            .content
            .get(&shell.key(&shell.active().unwrap()))
            .unwrap()
        {
            Content::Issues(i) => i.read(cx).worker_state(cx),
            _ => Value::Null,
        }
    });
    assert_eq!(state["draft"], "Retained worker draft");
}
