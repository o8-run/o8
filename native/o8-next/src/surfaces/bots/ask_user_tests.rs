//! Real Inbox click -> native composer -> durable question; scripted local client only.
use super::*;
use crate::shell::test_support::{draw, inbox_panel, open, ready};
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command as Process, Stdio},
    time::{Duration, Instant},
};

pub(crate) struct Fixture {
    server: Child,
    pub(crate) client: Client,
    pub(crate) data: Value,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        Self::start(false)
    }
    fn start(unicode_preview: bool) -> Self {
        let mut command = Process::new("node");
        command
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "native/o8-next/src/surfaces/bots/fixtures/ask-user.ts",
            ]);
        if unicode_preview {
            command.arg("--unicode-preview");
        }
        let mut server = command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let data = lines
            .by_ref()
            .find_map(|line| {
                let value: Value = serde_json::from_str(&line.ok()?).ok()?;
                value["origin"].as_str()?;
                Some(value)
            })
            .expect("scripted question fixture starts through real stdio");
        std::thread::spawn(move || for _ in lines {});
        let client = Client::authenticated(
            data["origin"].as_str().unwrap(),
            Some("native-question-fixture".into()),
        )
        .unwrap();
        Self {
            server,
            client,
            data,
        }
    }
    pub(crate) fn read(&self, path: &str) -> Value {
        self.client.get(path, &[]).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Process::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
    }
}
fn settle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..12 {
        cx.run_until_parked();
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
    }
}
fn click(cx: &mut VisualTestContext, id: &str) {
    let selector: &'static str = Box::leak(id.to_owned().into_boxed_str());
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut previous = None;
    loop {
        draw(cx);
        let bounds = cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("missing {selector}"));
        if previous == Some(bounds) || Instant::now() >= deadline {
            cx.simulate_click(bounds.center(), gpui::Modifiers::default());
            return;
        }
        previous = Some(bounds);
        std::thread::sleep(Duration::from_millis(30));
        cx.run_until_parked();
    }
}
fn selected(shell: &Entity<Shell>, cx: &VisualTestContext) -> String {
    shell.read_with(cx, |s, cx| {
        let tab = s.active().unwrap();
        let Some(Content::Session(view)) = s.content.get(&s.key(&tab)) else {
            panic!("native session must own the main pane")
        };
        view.read(cx).shell_selected()
    })
}

fn loaded_inbox(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<crate::inbox::Inbox> {
    let inbox = inbox_panel(shell, cx);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        draw(cx);
        if inbox.read_with(cx, |i, _| i.loaded && !i.loading) {
            assert!(inbox.read_with(cx, |i, _| i.errors[0].is_none()));
            assert!(inbox.read_with(cx, |i, _| i.errors.get(3).is_none_or(Option::is_none)));
            return inbox;
        }
        assert!(
            Instant::now() < deadline,
            "the actual Inbox response must finish loading"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn ask_user_unicode_question_preview_decodes_in_the_native_inbox() {
    let fixture = Fixture::start(true);
    let feed = fixture.read("/api/panel/supervisor-inbox?includeQuestions=1&questionsOnly=1");
    assert_eq!(feed["questions"].as_array().unwrap().len(), 1);
    assert_eq!(
        feed["questions"][0]["text"],
        format!("{}…", "x".repeat(1199))
    );
    assert_eq!(
        fixture.read("/fixture/ticket")["question"]["text"],
        format!("{}😀{}", "x".repeat(1199), "Local question ".repeat(130)).trim_end()
    );
}

#[gpui::test]
fn ask_user_native_inbox_click_answer_and_session_restart(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let repo = fixture.data["repo"].as_str().unwrap().to_owned();
    let thread = fixture.data["threadId"].as_str().unwrap().to_owned();
    let other = fixture.data["otherId"].as_str().unwrap().to_owned();
    let question = fixture.data["questionId"].as_str().unwrap();
    let file = PathBuf::from(fixture.data["root"].as_str().unwrap()).join("native-shell.json");
    let mut state = State::default();
    state.selected = Some(repo.clone());
    let workspace = state.workspaces.entry(repo).or_default();
    workspace.tabs.push(Tab::Session(other.clone()));
    workspace.composer = true;
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), state, cx);
    settle(&shell, &mut visual);
    assert!(
        shell.read_with(&visual, |s, _| s.connected),
        "fixture requests: {:?}",
        fixture.read("/fixture/state")
    );
    ready(&shell, &mut visual);
    assert_eq!(selected(&shell, &visual), other);
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Inbox, window, cx)
    });
    settle(&shell, &mut visual);
    let inbox = loaded_inbox(&shell, &mut visual);
    assert!(
        inbox.read_with(&visual, |i, _| i.cards[0]
            .iter()
            .any(|card| card.id == question)),
        "durable question must appear in existing Needs reply"
    );
    assert_eq!(
        selected(&shell, &visual),
        other,
        "opening Inbox preserves the main pane"
    );
    click(&mut visual, &format!("inbox-open-{question}"));
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert_eq!(selected(&shell, &visual), thread);
    click(&mut visual, "composer-input");
    visual.simulate_input("Yes, use the small local change.");
    visual.simulate_keystrokes("enter");
    settle(&shell, &mut visual);
    let ticket = fixture.read("/fixture/ticket");
    assert_eq!(ticket["question"]["status"], "answered");
    assert_eq!(
        ticket["question"]["answer"]["text"],
        "Yes, use the small local change."
    );
    let receipts = fixture.read("/fixture/state");
    assert_eq!(receipts["messages"].as_array().unwrap().len(), 2);
    assert_eq!(receipts["queue"], json!([]));
    assert_eq!(receipts["unexpectedDispatches"], 0);
    let restarted = fixture.read("/fixture/restart");
    assert_ne!(restarted["pid"], restarted["previousPid"]);
    assert_eq!(restarted["question"], ticket["question"]);
    let saved = State::load(&file).unwrap();
    assert!(visual.simulate_close());
    let (restored, mut next) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    settle(&restored, &mut next);
    ready(&restored, &mut next);
    assert_eq!(selected(&restored, &next), thread);
    let inbox = loaded_inbox(&restored, &mut next);
    assert!(inbox.read_with(&next, |i, _| {
        i.cards[0].iter().all(|card| card.id != question)
    }));
    assert_eq!(
        fixture.read("/fixture/state")["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
