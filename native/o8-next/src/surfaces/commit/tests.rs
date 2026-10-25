use super::*;
use crate::shell::test_support::*;
struct Fixture(crate::shell::test_support::Fixture);
impl std::ops::Deref for Fixture {
    type Target = crate::shell::test_support::Fixture;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Fixture {
    fn new() -> Self {
        Self::start_mode(false, "")
    }
    fn start_mode(projects: bool, option: &str) -> Self {
        Self(crate::shell::test_support::Fixture::start_mode(
            projects,
            &format!("{option} --commits"),
        ))
    }
}
#[gpui::test]
fn commit_viewer_is_reachable_from_shell(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("commits.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("o p e n space c o m m i t enter");
    draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active().unwrap().label()),
        "Commit",
        "commit viewer must be reachable through the real shell palette"
    );
    assert!(visual.debug_bounds("commit-hash").is_some());
}

fn wait_commit(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if shell.read_with(cx, |s,cx| matches!(s.content.get(&s.key(&Tab::Commit)), Some(Content::Commit(view)) if view.read(cx).test_ready())) {return;}
    }
    panic!("commit comparison must reach its CPU scene");
}
#[gpui::test]
fn commit_viewer_actions_reach_real_routes_and_frames(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let workspace = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let git = |args: &[&str]| {
        let output = Process::new("git")
            .arg("-C")
            .arg(&workspace)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    let hash = git(&["rev-parse", "HEAD"]);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("commit-actions.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let cx = &mut visual;
    let start = Instant::now();
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("o p e n space c o m m i t enter");
    draw(cx);
    let input = cx.debug_bounds("commit-hash").unwrap();
    cx.simulate_click(input.center(), gpui::Modifiers::default());
    cx.simulate_input(&hash);
    cx.simulate_keystrokes("enter");
    wait_commit(&shell, cx);
    let open_ms = start.elapsed().as_secs_f64() * 1000.;
    let editor = cx.debug_bounds("commit-editor").unwrap();
    cx.simulate_click(editor.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    let start = Instant::now();
    cx.simulate_input("export const value = 3;\n");
    draw(cx);
    let edit_ms = start.elapsed().as_secs_f64() * 1000.;
    cx.simulate_keystrokes("ctrl-s");
    wait_commit(&shell, cx);
    assert_eq!(
        fs::read_to_string(workspace.join("changed.ts")).unwrap(),
        "export const value = 3;\n"
    );
    // Commit includes the same save-first path when edits are still dirty.
    cx.simulate_click(editor.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("export const value = 4;\n");
    draw(cx);
    let message = cx.debug_bounds("commit-message").unwrap();
    cx.simulate_click(message.center(), gpui::Modifiers::default());
    cx.simulate_input("fixture native action");
    draw(cx);
    let commit = cx.debug_bounds("commit-create").unwrap();
    cx.simulate_click(commit.center(), gpui::Modifiers::default());
    wait_commit(&shell, cx);
    assert_eq!(git(&["log", "-1", "--format=%s"]), "fixture native action");
    assert_eq!(git(&["show", "HEAD:changed.ts"]), "export const value = 4;");
    let push = cx.debug_bounds("commit-push").unwrap();
    cx.simulate_click(push.center(), gpui::Modifiers::default());
    wait_commit(&shell, cx);
    assert!(shell.read_with(
        cx,
        |s, cx| match s.content.get(&s.key(&Tab::Commit)).unwrap() {
            Content::Commit(view) => view.read(cx).test_notice().contains("No git remote"),
            _ => false,
        }
    ));
    let remote = fixture.root.join("remote.git");
    assert!(
        Process::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&remote)
            .status()
            .unwrap()
            .success()
    );
    git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    cx.simulate_click(push.center(), gpui::Modifiers::default());
    wait_commit(&shell, cx);
    let branch = git(&["branch", "--show-current"]);
    let remote_head = Process::new("git")
        .arg("--git-dir")
        .arg(&remote)
        .args(["rev-parse", &format!("refs/heads/{branch}")])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(remote_head.stdout).unwrap().trim(),
        git(&["rev-parse", "HEAD"])
    );
    let removed = cx.debug_bounds("commit-file-1").unwrap();
    cx.simulate_click(removed.center(), gpui::Modifiers::default());
    wait_commit(&shell, cx);
    let editor = cx.debug_bounds("commit-editor").unwrap();
    cx.simulate_click(editor.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("restored by native\n");
    cx.simulate_keystrokes("ctrl-s");
    wait_commit(&shell, cx);
    assert_eq!(
        fs::read_to_string(workspace.join("removed.txt")).unwrap(),
        "restored by native\n"
    );
    let patch = cx.debug_bounds("commit-patch").unwrap();
    cx.simulate_click(patch.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    assert!(
        cx.debug_bounds("diff-unified").is_some(),
        "commit patches reuse the existing diff renderer"
    );
    cx.simulate_click(patch.center(), gpui::Modifiers::default());
    draw(cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("restored after patch\n");
    cx.simulate_keystrokes("ctrl-s");
    wait_commit(&shell, cx);
    assert_eq!(
        fs::read_to_string(workspace.join("removed.txt")).unwrap(),
        "restored after patch\n"
    );
    let hash_input = cx.debug_bounds("commit-hash").unwrap();
    cx.simulate_click(hash_input.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("not-a-hash");
    cx.simulate_keystrokes("enter");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        if let Content::Commit(view) = s.content.get(&s.key(&Tab::Commit)).unwrap() {
            assert!(
                !view.read(cx).test_ready(),
                "an invalid revision must clear the previously loaded comparison"
            );
        }
    });
    println!(
        "O8_NEXT_COMMIT_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene; no GPU/compositor", "openToFirstFrameMs":open_ms,"interactionToFrameMs":edit_ms,"savedFiles":2,"createdCommits":1,"localPushes":1,"noRemoteRefusals":1})
    );
}

#[path = "corrections.rs"]
mod corrections;
