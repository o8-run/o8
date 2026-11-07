//! #5303: setup in the desktop's frame, resuming where it stopped, with its
//! cues silent until sounds are turned on.
use super::super::view::sound::{self, Cue};
use super::*;

fn rail(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
) -> (Vec<(&'static str, String, bool)>, usize) {
    shell.read_with(cx, |s, cx| {
        s.surfaces.setup.view.as_ref().unwrap().read(cx).rail()
    })
}
fn page(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<&'static str> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .setup
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .painted_page()
    })
}

#[gpui::test]
fn onboarding_frame_resumes_where_it_stopped_and_cues_only_when_on(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("frame.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    sound::played();
    // The first page sits in the frame: wordmark, sounds switch and rail.
    for selector in [
        "setup-frame",
        "setup-rail",
        "setup-sounds",
        "setup-projects",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let (parts, current) = rail(&shell, cx);
    assert_eq!(current, 0);
    assert_eq!(
        parts,
        [
            ("Project", "Choose a folder".to_owned(), false),
            ("Agent", "Check readiness".to_owned(), false),
            ("Workspace", "Next".to_owned(), false),
        ]
    );
    // Sounds start off: choosing a project makes no cue.
    click(cx, "setup-project-0");
    assert_eq!(page(&shell, cx), Some("tools"));
    assert!(sound::played().is_empty(), "sounds are off until turned on");
    let project = fixture
        .client
        .get::<Value>("/api/panel/repos", &[])
        .unwrap()["repos"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let (parts, current) = rail(&shell, cx);
    assert_eq!(current, 1);
    assert_eq!(parts[0], ("Project", project.clone(), true));
    assert_eq!(parts[1].1, "Choose a tool");
    let saved = shell
        .read_with(cx, |s, _| s.state.onboarding.clone())
        .unwrap();
    assert_eq!(saved.step, "dispatch");
    assert_eq!(saved.project.as_ref().unwrap()["name"], project.as_str());
    // Turning sounds on previews a tick and is kept with the window.
    click(cx, "setup-sounds");
    assert_eq!(sound::played(), [Cue::Tick]);
    assert!(shell.read_with(cx, |s, _| s.state.onboarding_sounds));
    // Choices tick; moving forward chimes.
    click(cx, "setup-refresh");
    std::thread::sleep(std::time::Duration::from_millis(80));
    click(cx, "setup-lead-codex");
    std::thread::sleep(std::time::Duration::from_millis(80));
    click(cx, "setup-worker-claude-code");
    click(cx, "setup-use");
    assert_eq!(page(&shell, cx), Some("privacy"));
    assert_eq!(
        sound::played(),
        [Cue::Tick, Cue::Tick, Cue::Tick, Cue::Advance]
    );
    let (parts, current) = rail(&shell, cx);
    assert_eq!(current, 2);
    assert_eq!(parts[1], ("Agent", "Ready".to_owned(), true));
    assert_eq!(parts[2].1, "Privacy choices");
    // The cue files are written beside the window's saved state.
    let tick = fixture.root.join("sounds").join("onboarding-tick.wav");
    for _ in 0..200 {
        if tick.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(fs::read(&tick).unwrap(), sound::wav(Cue::Tick));

    // A relaunch with that saved state opens setup where it stopped.
    let state = shell.read_with(cx, |s, _| s.state.clone());
    assert_eq!(state.onboarding.as_ref().unwrap().step, "privacy");
    assert!(state.onboarding.as_ref().unwrap().tools_configured);
    let (again, mut relaunched) = open(
        fixture.client.clone(),
        fixture.root.join("frame-again.json"),
        state,
        cx,
    );
    let cx = &mut relaunched;
    cx.run_until_parked();
    draw(cx);
    assert_eq!(page(&again, cx), Some("privacy"));
    assert_eq!(rail(&again, cx).0[0], ("Project", project, true));
    sound::played();
    // Finishing chimes and clears the saved progress.
    click(cx, "setup-consent");
    assert!(again.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    assert_eq!(sound::played(), [Cue::Advance, Cue::Complete]);
    assert!(again.read_with(cx, |s, _| s.state.onboarding.is_none()));
}
