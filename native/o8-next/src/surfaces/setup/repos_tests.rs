//! #5303 PR 3: the desktop's project step (OnboardingReposStep), against the
//! fixture's fixed GitHub answers. GitHub sign-in stays outside setup.
use super::click;
use crate::shell::test_support::*;
use crate::shell::*;

fn page(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<&'static str> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .setup
            .view
            .as_ref()
            .and_then(|v| v.read(cx).painted_page())
    })
}
fn error(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .setup
            .view
            .as_ref()
            .and_then(|v| v.read(cx).error().map(str::to_owned))
    })
}
fn registered(fixture: &Fixture) -> Vec<String> {
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    repos["repos"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["localPath"].as_str().map(str::to_owned))
        .collect()
}
fn saved_step(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> String {
    shell
        .read_with(cx, |s, _| s.state.onboarding.clone())
        .unwrap()
        .step
}

#[gpui::test]
fn onboarding_repos_signed_out_names_the_github_cli(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(
        false,
        "--onboarding --onboarding-github-signed-out --transcript",
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("repos-signed-out.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-clone");
    assert_eq!(page(&shell, cx), Some("repos"));
    assert_eq!(saved_step(&shell, cx), "repos");
    // Not connected: the desktop's notice, and no way to sign in from setup.
    assert!(cx.debug_bounds("setup-github-signed-out").is_some());
    assert!(cx.debug_bounds("setup-repos-loading").is_none());
    // The project already in o8 is listed as local and opens from here.
    assert!(cx.debug_bounds("setup-repo-0-local").is_some());
    assert!(cx.debug_bounds("setup-repo-1").is_none());
    assert!(
        cx.debug_opacity("setup-repos-use")
            .is_some_and(|o| o <= 0.5),
        "nothing is chosen yet"
    );
    click(cx, "setup-repo-0");
    assert!(cx.debug_bounds("setup-repo-0-box").is_some());
    assert!(cx.debug_opacity("setup-repos-use").is_some_and(|o| o > 0.5));
    // Hiding GitHub hides the notice; Choose later returns home.
    click(cx, "setup-repos-github");
    assert!(cx.debug_bounds("setup-github-signed-out").is_none());
    click(cx, "setup-repos-later");
    assert_eq!(page(&shell, cx), Some("projects"));
}

#[gpui::test]
fn onboarding_repos_clone_from_github_opens_the_project(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(
        false,
        "--onboarding --onboarding-github --onboarding-tools --transcript",
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("repos-clone.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-clone");
    assert!(cx.debug_bounds("setup-github-signed-out").is_none());
    // The local project first, then the account's repositories.
    assert!(cx.debug_bounds("setup-repo-0-local").is_some());
    for row in ["setup-repo-1", "setup-repo-2", "setup-repo-3"] {
        assert!(cx.debug_bounds(row).is_some(), "{row}");
    }
    assert!(cx.debug_bounds("setup-repo-2-private").is_some());
    assert!(cx.debug_bounds("setup-repo-1-private").is_none());
    // Search filters by name and description.
    click(cx, "setup-repos-search");
    cx.simulate_input("private fixture");
    draw(cx);
    assert!(cx.debug_bounds("setup-repo-2").is_some());
    assert!(cx.debug_bounds("setup-repo-1").is_none());
    cx.simulate_input("zzz");
    draw(cx);
    assert!(cx.debug_bounds("setup-repos-no-match").is_some());
    cx.simulate_keystrokes("cmd-a backspace");
    draw(cx);
    assert!(cx.debug_bounds("setup-repo-1").is_some());
    // Use this project clones through the server, registers and opens it.
    click(cx, "setup-repo-1");
    click(cx, "setup-repos-use");
    let cloned = registered(&fixture)
        .into_iter()
        .find(|path| path.ends_with("/Developer/fixture-app"))
        .expect("the clone is registered from the projects folder");
    assert_eq!(error(&shell, cx), None);
    assert_eq!(page(&shell, cx), Some("privacy"));
    let project = shell
        .read_with(cx, |s, _| s.state.onboarding.clone())
        .unwrap()
        .project
        .unwrap();
    assert_eq!(project["localPath"], cloned.as_str());
}

#[gpui::test]
fn onboarding_repos_failed_clone_shows_only_fixed_copy(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(
        false,
        "--onboarding --onboarding-github --onboarding-tools --transcript",
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("repos-failed.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let before = registered(&fixture);
    click(cx, "setup-clone");
    click(cx, "setup-repo-3");
    click(cx, "setup-repos-use");
    // The server answered 502 with git's stderr; the page shows its own copy.
    let shown = error(&shell, cx).expect("a failed clone explains itself");
    assert_eq!(
        shown,
        "Couldn’t clone this project. Try again, or choose a folder on this Mac."
    );
    assert!(!shown.contains("fatal") && !shown.contains("Clone failed"));
    assert!(cx.debug_bounds("setup-repos-error").is_some());
    assert!(cx.debug_bounds("setup-repos-retry").is_none());
    assert!(cx.debug_bounds("setup-repo-3-failed").is_some());
    assert_eq!(page(&shell, cx), Some("repos"));
    assert_eq!(registered(&fixture), before);
}

#[gpui::test]
fn onboarding_repos_folder_comes_back_selected(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(
        false,
        "--onboarding --onboarding-github-signed-out --transcript",
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("repos-folder.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-clone");
    // Cancel returns to this step, not home.
    click(cx, "setup-repos-folder");
    assert_eq!(page(&shell, cx), Some("folder"));
    click(cx, "setup-cancel-folder");
    assert_eq!(page(&shell, cx), Some("repos"));
    let repo = fixture.root.join("picked-repo");
    fs::create_dir(&repo).unwrap();
    assert!(
        Process::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success()
    );
    click(cx, "setup-repos-folder");
    click(cx, "setup-folder-input");
    cx.simulate_input(repo.to_str().unwrap());
    click(cx, "setup-add");
    // Registered, back on this step and chosen, but not opened yet.
    assert_eq!(page(&shell, cx), Some("repos"));
    assert!(
        registered(&fixture)
            .iter()
            .any(|path| { fs::canonicalize(path).unwrap() == fs::canonicalize(&repo).unwrap() })
    );
    assert!(cx.debug_opacity("setup-repos-use").is_some_and(|o| o > 0.5));
    assert!(
        shell
            .read_with(cx, |s, _| s.state.onboarding.clone())
            .unwrap()
            .project
            .is_none()
    );
}

#[gpui::test]
fn onboarding_repos_status_that_breaks_off_offers_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(
        false,
        "--onboarding --onboarding-github-unreachable --transcript",
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("repos-unreachable.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-clone");
    assert_eq!(page(&shell, cx), Some("repos"));
    // As on the desktop: not "not connected", but a load that can be retried.
    assert!(cx.debug_bounds("setup-github-signed-out").is_none());
    assert!(cx.debug_bounds("setup-repos-error").is_some());
    assert!(cx.debug_bounds("setup-repos-retry").is_some());
    click(cx, "setup-repos-retry");
    assert!(cx.debug_bounds("setup-repos-error").is_some());
    assert!(cx.debug_bounds("setup-repo-0-local").is_some());
}
