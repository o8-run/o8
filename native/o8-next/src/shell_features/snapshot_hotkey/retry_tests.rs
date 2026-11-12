use super::*;
use crate::shell::test_support::*;

fn cancelled_retry(cx: &mut TestAppContext, settings: bool) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar --settings");
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(), fixture.root.join("snapshot-retry.json"),
        crate::shell_state::State::default(), cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, w, cx| {
        s.open_thread("thoughts-composer-first".into(), w, cx);
    });
    ready(&shell, &mut visual);
    let path = fixture.root.join("capture.png");
    fs::write(&path, b"retained capture").unwrap();
    let (id, workspace, active, focus) = shell.update_in(&mut visual, |s, w, cx| {
        let id = s.start_thread(true, cx).unwrap();
        s.features.get::<Hotkey>().pending = Some(Pending {
            path: path.clone(), id: Some(id.clone()),
            deadline: Instant::now() + Duration::from_secs(30),
        });
        s.execute(if settings { Command::Settings } else { Command::Projects }, w, cx);
        (id, s.state.selected.clone(), s.active(), w.focused(cx))
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        shell.update_in(&mut visual, |s, w, cx| s.tick(true, w, cx));
        visual.run_until_parked();
        draw(&mut visual);
        if shell.read_with(&visual, |s, _| s.sessions.iter().any(|t| t.id == id)) { break; }
        assert!(Instant::now() < deadline, "created thread reaches catalog");
        std::thread::sleep(Duration::from_millis(10));
    }
    shell.update_in(&mut visual, |s, w, cx| {
        s.deliver_snapshot(w, cx);
        assert_eq!(s.state.selected, workspace);
        assert_eq!(s.active(), active, "snapshot retry must not activate the late thread");
        assert_eq!(w.focused(cx), focus, "snapshot retry must preserve keyboard focus");
        assert_eq!(s.state.workspaces.values().flat_map(|saved| {
            saved.tabs.iter().filter(|tab| match tab {
                Tab::Session(key) => saved.selections.get(key).unwrap_or(key) == &id,
                _ => false,
            })
        }).count(), 1, "the shared opener retains exactly one background tab");
        if settings { assert!(s.surfaces.settings.view.is_some()); }
        else { assert!(s.surfaces.projects.open); }
    });
    assert!(path.exists(), "cancelled capture stays available");
}
#[gpui::test]
fn snapshot_retry_after_settings_does_not_take_over(cx: &mut TestAppContext) {
    cancelled_retry(cx, true);
}
#[gpui::test]
fn snapshot_retry_after_projects_does_not_take_over(cx: &mut TestAppContext) {
    cancelled_retry(cx, false);
}
