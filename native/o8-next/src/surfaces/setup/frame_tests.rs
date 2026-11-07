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
/// The workspace chrome that setup must cover: rail, sidebar and header.
const CHROME: [&str; 3] = ["rail-more", "sidebar-new-thread", "header-right-panel-hit"];

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
        "setup-window",
        "setup-frame",
        "setup-rail",
        "setup-sounds",
        "setup-privacy-link",
        "setup-projects",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    // Home, as on the desktop: no back link, and Check again only with an error.
    assert!(cx.debug_bounds("setup-back").is_none());
    assert!(cx.debug_bounds("setup-refresh").is_none());
    // Setup is its own full-window page: no workspace chrome behind it.
    for selector in CHROME {
        assert!(
            cx.debug_bounds(selector).is_none(),
            "{selector} under setup"
        );
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
    // Away from home: "← Projects" and the project being set up.
    assert!(cx.debug_bounds("setup-back").is_some());
    let saved = shell
        .read_with(cx, |s, _| s.state.onboarding.clone())
        .unwrap();
    assert_eq!(saved.step, "dispatch");
    assert_eq!(saved.project.as_ref().unwrap()["name"], project.as_str());
    // Turning sounds on previews a tick and is kept with the window.
    click(cx, "setup-sounds");
    assert_eq!(sound::played(), [Cue::Tick]);
    assert!(shell.read_with(cx, |s, _| s.state.onboarding_sounds));
    // Choices tick, each one more than the 75 ms debounce apart.
    std::thread::sleep(std::time::Duration::from_millis(80));
    click(cx, "setup-refresh");
    std::thread::sleep(std::time::Duration::from_millis(80));
    click(cx, "setup-lead-codex");
    std::thread::sleep(std::time::Duration::from_millis(80));
    click(cx, "setup-worker-claude-code");
    std::thread::sleep(std::time::Duration::from_millis(80));
    click(cx, "setup-use");
    assert_eq!(page(&shell, cx), Some("privacy"));
    // As on the desktop, project, tool and Use choices tick; only the
    // optional voice and iPhone offers chime advance.
    assert_eq!(
        sound::played(),
        [Cue::Tick, Cue::Tick, Cue::Tick, Cue::Tick]
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
    scroll_privacy(cx);
    click(cx, "setup-crashes-off");
    sound::played();
    std::thread::sleep(std::time::Duration::from_millis(80));
    // Finishing ticks, plays complete and clears the saved progress.
    click(cx, "setup-consent");
    assert!(again.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    assert_eq!(sound::played(), [Cue::Tick, Cue::Complete]);
    assert!(again.read_with(cx, |s, _| s.state.onboarding.is_none()));
    // The workspace comes back once setup is done.
    cx.run_until_parked();
    draw(cx);
    assert!(cx.debug_bounds("setup-window").is_none());
    for selector in CHROME {
        assert!(
            cx.debug_bounds(selector).is_some(),
            "{selector} after setup"
        );
    }
}

#[gpui::test]
fn onboarding_resumed_project_that_was_removed_goes_back_to_projects(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let state = State {
        onboarding: Some(crate::shell_state::OnboardingProgress {
            step: "dispatch".into(),
            project: Some(serde_json::json!({
                "id": "removed-project",
                "name": "Removed",
                "localPath": "/nowhere/removed",
            })),
            ..Default::default()
        }),
        ..State::default()
    };
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("removed.json"),
        state,
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    assert_eq!(page(&shell, cx), Some("projects"));
    let (parts, current) = rail(&shell, cx);
    assert_eq!(current, 0);
    assert_eq!(parts[0], ("Project", "Choose a folder".to_owned(), false));
}

#[test]
fn malformed_onboarding_progress_keeps_the_rest_of_the_window_state() {
    let dir = std::env::temp_dir().join(format!("o8-setup-malformed-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let mut kept = State::default();
    kept.keybindings.insert("cmd-k".into(), "palette".into());
    let mut saved = serde_json::to_value(&kept).unwrap();
    for (onboarding, sounds) in [
        (serde_json::json!({}), serde_json::json!(true)),
        (serde_json::json!({"step": 5}), serde_json::json!("on")),
        (serde_json::json!("dispatch"), serde_json::json!(null)),
    ] {
        saved["onboarding"] = onboarding.clone();
        saved["onboarding_sounds"] = sounds.clone();
        let file = dir.join("state.json");
        fs::write(&file, serde_json::to_vec(&saved).unwrap()).unwrap();
        let loaded = State::load(&file).unwrap();
        assert_eq!(
            loaded.keybindings, kept.keybindings,
            "{onboarding} {sounds}"
        );
        // A step-less object reads as progress with no step, which setup
        // starts over from; anything else is dropped.
        let step = loaded.onboarding.map(|progress| progress.step);
        assert!(matches!(step.as_deref(), None | Some("")), "{onboarding}");
        assert_eq!(loaded.onboarding_sounds, sounds == true, "{sounds}");
    }
    let _ = fs::remove_dir_all(&dir);
}
