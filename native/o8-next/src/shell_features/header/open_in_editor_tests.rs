//! Thread header Open in editor: header click -> editor command -> spawned `code`.
use super::*;
use crate::shell::test_support::*;

/// Points the open thread at `path`, on `machine` when one is given.
fn point_thread(
    shell: &Entity<Shell>,
    visual: &mut VisualTestContext,
    path: &str,
    machine: Option<&str>,
) {
    shell.update(visual, |s, cx| {
        let Tab::Session(id) = s.active().unwrap() else {
            panic!("thread tab")
        };
        let selected = s.current().unwrap().selections.get(&id).unwrap_or(&id);
        let selected = selected.clone();
        let session = s.sessions.iter_mut().find(|s| s.id == selected).unwrap();
        let mut next: crate::client::Session = serde_json::from_value(json!({
            "id": selected, "runtime": session.runtime, "status": "idle",
            "title": "Editor", "repoPath": path
        }))
        .unwrap();
        next.machine = machine.map(str::to_owned);
        *session = next;
        cx.notify();
    });
    draw(visual);
}

#[gpui::test]
fn thread_header_opens_the_threads_project_in_the_editor(cx: &mut TestAppContext) {
    let (_code, log) = crate::editor_command::fake_code::install();
    let fixture = Fixture::start_mode(false, "");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("header-editor.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let path = fixture
        .root
        .join("my project")
        .to_string_lossy()
        .into_owned();
    point_thread(&shell, &mut visual, &path, None);
    let button = visual
        .debug_bounds("thread-header-open-in-editor")
        .expect("Open in editor in the thread header");
    let header = visual.debug_bounds("thread-header").unwrap();
    assert!(header.contains(&button.center()));
    visual.simulate_click(button.center(), gpui::Modifiers::default());
    let started = Instant::now();
    while crate::editor_command::fake_code::args(&log).is_empty() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "code never ran"
        );
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(crate::editor_command::fake_code::args(&log), [path]);

    // A thread on a machine the registry has no host for runs nothing and says why.
    fs::write(&log, "").unwrap();
    point_thread(&shell, &mut visual, "/home/me/repo", Some("unsaved-box"));
    let button = visual.debug_bounds("thread-header-open-in-editor").unwrap();
    visual.simulate_click(button.center(), gpui::Modifiers::default());
    let wanted = "This project's machine has no saved SSH host.";
    let started = Instant::now();
    while !visual
        .update(|_, cx| crate::shell::toasts::texts(cx))
        .iter()
        .any(|text| text == wanted)
    {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no error shown"
        );
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(crate::editor_command::fake_code::args(&log).is_empty());
    assert!(visual.simulate_close());
}
