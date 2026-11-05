use super::{GitActions, can_open_pull_request, pull_request_url};
use crate::shell::palette::tests::{run, settled};
use crate::shell::test_support::*;
use crate::shell::{Content, State, Tab};
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
    assert!(!can_open_pull_request(Some("HEAD")), "detached");
    assert!(can_open_pull_request(Some("fix/thing")));
    assert_eq!(pull_request_url(None, Some("fix/thing")), None);
    assert_eq!(pull_request_url(Some(""), Some("fix/thing")), None);
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

#[gpui::test]
fn review_commits_pushes_and_opens_a_pull_request_through_the_review_routes(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start_mode(false, "--review --review-git");
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
    let wait =
        |cx: &mut VisualTestContext, what: &str, done: &dyn Fn(&mut VisualTestContext) -> bool| {
            let started = Instant::now();
            loop {
                settled(&shell, cx);
                if done(cx) {
                    break;
                }
                assert!(started.elapsed() < Duration::from_secs(15), "{what}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
    let click = |cx: &mut VisualTestContext, id: &'static str| {
        let bounds = cx.debug_bounds(id).unwrap_or_else(|| panic!("{id}"));
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        settled(&shell, cx);
    };
    let actions = |cx: &mut VisualTestContext| -> Entity<GitActions> {
        view.read_with(cx, |v, _| {
            v.bar
                .clone()
                .expect("Git actions")
                .downcast::<GitActions>()
                .unwrap()
        })
    };
    let files = |cx: &mut VisualTestContext| -> Vec<String> {
        view.read_with(cx, |v, cx| {
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
    };
    wait(cx, "the note is a working change", &|cx| {
        files(cx).iter().any(|f| f == "git-note.txt")
    });
    wait(cx, "branch read", &|cx| {
        actions(cx).read_with(cx, |a, _| a.branch.is_some())
    });
    let git_actions = actions(cx);
    let (branch, slug): (Option<String>, Option<String>) = git_actions.read_with(cx, |a, _| (a.branch.clone(), a.slug.clone()));
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
    settled(&shell, cx);
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
    settled(&shell, cx);
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
