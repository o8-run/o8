use super::{
    COMMIT_BUDGET, GitActions, RELEASE_POST_TIMEOUT, can_open_pull_request, pull_request_url,
};
use crate::shell::palette::tests::{run, settled};
use crate::shell::test_support::*;
use crate::shell::{Content, Shell, State, Tab};
use gpui::Entity;
use std::process::Command as Git;
use std::time::Duration;

#[test]
fn a_pull_request_needs_a_feature_branch_and_a_github_repository() {
    assert_eq!(
        pull_request_url(Some("o8-fixture/review"), Some("fix/thing")).as_deref(),
        Some("https://github.com/o8-fixture/review/compare/fix/thing?expand=1")
    );
    for branch in [None, Some(""), Some("main"), Some("master")] {
        assert_eq!(pull_request_url(Some("o8-fixture/review"), branch), None);
        assert!(!can_open_pull_request(branch), "{branch:?}");
    }
    // `git status` names a detached head `(detached)`; the route falls back
    // to `unknown`.
    for branch in ["HEAD", "(detached)", "unknown"] {
        assert!(!can_open_pull_request(Some(branch)), "{branch}");
        assert_eq!(
            pull_request_url(Some("o8-fixture/review"), Some(branch)),
            None
        );
    }
    assert!(can_open_pull_request(Some("fix/thing")));
    assert_eq!(
        pull_request_url(Some("o8-fixture/review"), Some("fix/a b#1")).as_deref(),
        Some("https://github.com/o8-fixture/review/compare/fix/a%20b%231?expand=1"),
        "the branch is one encoded path"
    );
    assert_eq!(pull_request_url(None, Some("fix/thing")), None);
    assert_eq!(pull_request_url(Some(""), Some("fix/thing")), None);
}

/// Commit's hooks may run 15 s and push 30 s on the server
/// (`src/app/api/review/commit/route.ts`, `push/route.ts`), so the app waits
/// at least as long as both before it calls an outcome unknown.
#[test]
fn the_release_deadline_outlasts_the_hooks_and_the_push() {
    assert!(
        RELEASE_POST_TIMEOUT >= Duration::from_secs(15 + 30),
        "{RELEASE_POST_TIMEOUT:?}"
    );
}

fn git(path: &std::path::Path, args: &[&str]) -> String {
    let out = Git::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

struct Rig {
    _fixture: Fixture,
    shell: Entity<Shell>,
    view: Entity<crate::shell::palette::target::Picker<crate::shell::diff::PacketDiff>>,
    path: std::path::PathBuf,
}

/// The review fixture with a GitHub origin, its Changes tab open on a new
/// note.
fn rig(options: &str, cx: &mut TestAppContext) -> (Rig, VisualTestContext) {
    let fixture = Fixture::start_mode(false, options);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("review-git.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let workspace = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let path = std::path::PathBuf::from(crate::shell::session::workspace_path(&workspace));
    fs::write(path.join("git-note.txt"), "commit me\n").unwrap();
    run(cx, "d i f f");
    let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&Tab::Diff)] {
        Content::Diff(v) => v.clone(),
        _ => panic!("diff"),
    });
    let rig = Rig {
        _fixture: fixture,
        shell,
        view,
        path,
    };
    rig.wait(cx, "the note is a working change", &|rig, cx| {
        rig.files(cx).iter().any(|f| f == "git-note.txt")
    });
    rig.wait(cx, "branch read", &|rig, cx| {
        rig.actions(cx).read_with(cx, |a, _| a.branch.is_some())
    });
    (rig, visual)
}

impl Rig {
    fn wait(
        &self,
        cx: &mut VisualTestContext,
        what: &str,
        done: &dyn Fn(&Self, &mut VisualTestContext) -> bool,
    ) {
        let started = Instant::now();
        loop {
            settled(&self.shell, cx);
            if done(self, cx) {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(20), "{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn click(&self, cx: &mut VisualTestContext, id: &'static str) {
        let bounds = cx.debug_bounds(id).unwrap_or_else(|| panic!("{id}"));
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        settled(&self.shell, cx);
    }

    fn actions(&self, cx: &mut VisualTestContext) -> Entity<GitActions> {
        self.view.read_with(cx, |v, _| {
            v.bar
                .clone()
                .expect("Git actions")
                .downcast::<GitActions>()
                .unwrap()
        })
    }

    fn files(&self, cx: &mut VisualTestContext) -> Vec<String> {
        self.view.read_with(cx, |v, cx| {
            v.child.as_ref().map_or(vec![], |child| {
                let child = child.read(cx);
                if !child.ready {
                    return vec!["(loading)".into()];
                }
                child
                    .document
                    .files
                    .iter()
                    .map(|f| f.path.clone())
                    .collect()
            })
        })
    }

    fn type_message(&self, cx: &mut VisualTestContext, text: &str) {
        let input = self.actions(cx).read_with(cx, |a, _| a.input.clone());
        input.update(cx, |input, cx| input.set_text(text, cx));
        settled(&self.shell, cx);
    }
}

#[gpui::test]
fn review_commits_pushes_and_opens_a_pull_request_through_the_review_routes(
    cx: &mut TestAppContext,
) {
    let (rig, mut visual) = rig("--review --review-git", cx);
    let cx = &mut visual;
    let (path, view) = (rig.path.clone(), rig.view.clone());
    let wait =
        |cx: &mut VisualTestContext, what: &str, done: &dyn Fn(&mut VisualTestContext) -> bool| {
            rig.wait(cx, what, &|_, cx| done(cx))
        };
    let click = |cx: &mut VisualTestContext, id: &'static str| rig.click(cx, id);
    let files = |cx: &mut VisualTestContext| rig.files(cx);
    let git_actions = rig.actions(cx);
    let (branch, slug): (Option<String>, Option<String>) =
        git_actions.read_with(cx, |a, _| (a.branch.clone(), a.slug.clone()));
    assert_eq!(branch.as_deref(), Some("fixture-review"));
    assert_eq!(slug.as_deref(), Some("o8-fixture/review"));

    // Commit: the message box commits every working change with the typed message.
    click(cx, "review-commit");
    assert!(cx.debug_bounds("review-commit-input").is_some());
    // An empty message commits nothing.
    click(cx, "review-commit-submit");
    assert_eq!(git_actions.read_with(cx, |a, _| a.busy), None);
    let input: Entity<crate::composer::Composer> =
        git_actions.read_with(cx, |a, _| a.input.clone());
    input.update(cx, |input, cx| input.set_text("Add the review note", cx));
    settled(&rig.shell, cx);
    let before = git(&path, &["rev-parse", "HEAD"]);
    click(cx, "review-commit-submit");
    wait(cx, "commit reply", &|cx| {
        git_actions.read_with(cx, |a, _| a.busy.is_none() && a.toast.is_some())
    });
    let (toast, composing) = git_actions.read_with(cx, |a, _| (a.toast.clone(), a.composing));
    let toast = toast.unwrap();
    assert!(!toast.1 && toast.0.starts_with("Committed "), "{toast:?}");
    assert!(!composing, "the message box closes after a commit");
    assert_ne!(git(&path, &["rev-parse", "HEAD"]), before);
    assert_eq!(
        git(&path, &["log", "-1", "--format=%s"]),
        "Add the review note"
    );
    assert!(cx.debug_bounds("review-git-toast").is_some());
    // The committed note leaves the working changes.
    wait(cx, "diff reloads after the commit", &|cx| {
        files(cx).is_empty()
    });

    // A clean tree: the route's refusal shows in the message box.
    click(cx, "review-commit");
    input.update(cx, |input, cx| input.set_text("Nothing to add", cx));
    settled(&rig.shell, cx);
    click(cx, "review-commit-submit");
    wait(cx, "refusal", &|cx| {
        git_actions.read_with(cx, |a, _| a.error.is_some())
    });
    assert_eq!(
        git_actions.read_with(cx, |a, _| a.error.clone()).as_deref(),
        Some("No changes to commit")
    );
    assert!(cx.debug_bounds("review-commit-error").is_some());
    click(cx, "review-commit-cancel");
    assert!(cx.debug_bounds("review-commit-box").is_none());

    // Push, from the caret menu, sends the branch to the remote.
    let remote = std::path::PathBuf::from(git(&path, &["config", "remote.origin.pushurl"]));
    click(cx, "review-git-more");
    assert!(cx.debug_bounds("review-git-menu").is_some());
    click(cx, "review-git-push");
    wait(cx, "push reply", &|cx| {
        git_actions.read_with(cx, |a, _| {
            a.busy.is_none() && a.toast.as_ref().is_some_and(|t| t.0.starts_with("Pushed"))
        })
    });
    let toast = git_actions.read_with(cx, |a, _| a.toast.clone()).unwrap();
    assert!(!toast.1, "{toast:?}");
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/fixture-review"]),
        git(&path, &["rev-parse", "HEAD"])
    );

    // Open pull request pushes again and opens GitHub's form for the branch.
    fs::write(path.join("git-note.txt"), "commit me again\n").unwrap();
    git(&path, &["add", "git-note.txt"]);
    git(&path, &["commit", "-qm", "second"]);
    click(cx, "review-open-pr");
    wait(cx, "open pull request", &|cx| cx.opened_url().is_some());
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("https://github.com/o8-fixture/review/compare/fixture-review?expand=1")
    );
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/fixture-review"]),
        git(&path, &["rev-parse", "HEAD"]),
        "the new commit is pushed before the form opens"
    );

    // A packet's diff has no Git actions.
    click(cx, "target-switch");
    assert!(view.read_with(cx, |v, _| v.bar.is_none()));
    click(cx, "target-1");
    wait(cx, "packet diff", &|cx| {
        view.read_with(cx, |v, cx| {
            v.child.as_ref().is_some_and(|child| {
                matches!(child.read(cx).target, crate::diff::Target::Packet(_))
            })
        })
    });
    assert!(view.read_with(cx, |v, _| v.bar.is_none()));
    assert!(cx.debug_bounds("review-commit").is_none());
}

/// A slow pre-commit hook outlasts the request: the commit may still land,
/// so Review says the outcome is unknown and shows what Git has now, never a
/// failure that invites a second commit.
#[gpui::test]
fn a_commit_without_a_reply_in_time_reloads_instead_of_failing(cx: &mut TestAppContext) {
    let (rig, mut visual) = rig("--review --review-git", cx);
    let cx = &mut visual;
    let hook = rig.path.join(".git/hooks/pre-commit");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(&hook, "#!/bin/sh\nsleep 6\n").unwrap();
    std::process::Command::new("chmod")
        .args(["+x"])
        .arg(&hook)
        .status()
        .unwrap();
    let actions = rig.actions(cx);
    let before = git(&rig.path, &["rev-parse", "HEAD"]);
    rig.click(cx, "review-commit");
    rig.type_message(cx, "Slow hook commit");
    rig.click(cx, "review-commit-submit");
    rig.wait(cx, "commit outcome", &|_, cx| {
        actions.read_with(cx, |a, _| a.busy.is_none() && a.toast.is_some())
    });
    let (toast, error, composing) =
        actions.read_with(cx, |a, _| (a.toast.clone(), a.error.clone(), a.composing));
    let toast = toast.unwrap();
    assert!(
        toast.0.starts_with("No reply from the commit in time"),
        "{toast:?}"
    );
    assert_eq!(error, None, "no refusal in the message box");
    assert!(!composing);
    rig.wait(cx, "the commit lands", &|rig, _| {
        git(&rig.path, &["log", "-1", "--format=%s"]) == "Slow hook commit"
    });
    assert_ne!(git(&rig.path, &["rev-parse", "HEAD"]), before);
    // The server answers other requests while the hook runs, so the reload at
    // the timeout can read the changes before the commit lands. The changes
    // are read again once the commit's budget is over.
    cx.cx.executor().advance_clock(COMMIT_BUDGET);
    rig.wait(cx, "the diff reloads", &|rig, cx| rig.files(cx).is_empty());
}

/// On a detached head Open pull request is off and opens nothing.
#[gpui::test]
fn open_pull_request_is_off_on_a_detached_head(cx: &mut TestAppContext) {
    let (rig, mut visual) = rig("--review --review-git --review-git-detached", cx);
    let cx = &mut visual;
    assert_eq!(
        git(&rig.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "HEAD"
    );
    let actions = rig.actions(cx);
    assert_eq!(
        actions.read_with(cx, |a, _| a.branch.clone()).as_deref(),
        Some("(detached)"),
        "the workspace snapshot's own value"
    );
    rig.click(cx, "review-open-pr");
    assert_eq!(actions.read_with(cx, |a, _| a.busy), None, "no push starts");
    std::thread::sleep(Duration::from_millis(1500));
    settled(&rig.shell, cx);
    assert_eq!(
        actions.read_with(cx, |a, _| a.toast.clone()),
        None,
        "nothing was pushed or refused"
    );
    assert_eq!(cx.opened_url(), None);
}

/// Escape closes the caret menu and the message box.
#[gpui::test]
fn escape_closes_the_menu_and_the_message_box(cx: &mut TestAppContext) {
    let (rig, mut visual) = rig("--review --review-git", cx);
    let cx = &mut visual;
    rig.click(cx, "review-git-more");
    assert!(cx.debug_bounds("review-git-menu").is_some());
    cx.simulate_keystrokes("escape");
    settled(&rig.shell, cx);
    assert!(cx.debug_bounds("review-git-menu").is_none());
    rig.click(cx, "review-commit");
    rig.type_message(cx, "kept");
    cx.simulate_keystrokes("escape");
    settled(&rig.shell, cx);
    assert!(cx.debug_bounds("review-commit-box").is_none());
    let actions = rig.actions(cx);
    assert_eq!(
        actions.read_with(cx, |a, cx| a.input.read(cx).text.clone()),
        "kept",
        "the message stays for next time"
    );
}

/// After a commit, Review reads Git's current branch, not the workspace
/// snapshot the server keeps for up to 20 s.
#[gpui::test]
fn the_branch_after_a_commit_is_read_from_git_now(cx: &mut TestAppContext) {
    let (rig, mut visual) = rig("--review --review-git", cx);
    let cx = &mut visual;
    let actions = rig.actions(cx);
    assert_eq!(
        actions.read_with(cx, |a, _| a.branch.clone()).as_deref(),
        Some("fixture-review")
    );
    // A branch switch outside the app, inside the snapshot's 20 s.
    git(&rig.path, &["checkout", "-qb", "fix/outside"]);
    rig.click(cx, "review-commit");
    rig.type_message(cx, "Commit on the new branch");
    rig.click(cx, "review-commit-submit");
    rig.wait(cx, "commit reply", &|_, cx| {
        actions.read_with(cx, |a, _| a.busy.is_none() && a.toast.is_some())
    });
    let started = Instant::now();
    loop {
        settled(&rig.shell, cx);
        let branch = actions.read_with(cx, |a, _| a.branch.clone());
        if branch.as_deref() == Some("fix/outside") {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the branch is still {branch:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Branch reads can answer out of order: a slower, older read never
/// overwrites a newer one.
#[gpui::test]
fn an_older_branch_read_never_overwrites_a_newer_one(cx: &mut TestAppContext) {
    let (rig, mut visual) = rig("--review --review-git", cx);
    let cx = &mut visual;
    let actions = rig.actions(cx);
    actions.update(cx, |a, cx| {
        let older = a.branch_reads + 1;
        let newer = a.branch_reads + 2;
        a.branch_reads = newer;
        a.apply_branch(
            newer,
            Some("fix/newer".into()),
            Some("o8-fixture/review".into()),
            cx,
        );
        a.apply_branch(
            older,
            Some("fix/older".into()),
            Some("o8-fixture/old".into()),
            cx,
        );
    });
    let (branch, slug) = actions.read_with(cx, |a, _| (a.branch.clone(), a.slug.clone()));
    assert_eq!(branch.as_deref(), Some("fix/newer"));
    assert_eq!(slug.as_deref(), Some("o8-fixture/review"));
    // An older read that lands first still shows until the newer one lands.
    actions.update(cx, |a, cx| {
        let older = a.branch_reads + 1;
        let newer = a.branch_reads + 2;
        a.branch_reads = newer;
        a.apply_branch(older, Some("fix/first".into()), None, cx);
        assert_eq!(a.branch.as_deref(), Some("fix/first"));
        a.apply_branch(newer, Some("fix/second".into()), None, cx);
    });
    assert_eq!(
        actions.read_with(cx, |a, _| a.branch.clone()).as_deref(),
        Some("fix/second")
    );
}
