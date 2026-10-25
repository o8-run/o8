//! Review round 2 uses the real shell and production Git endpoints.
use super::corrections::{click, git, open_commit, workspace};
use super::*;

#[gpui::test]
fn nonsecret_code_references_remain_editable(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        workspace(&fixture).join("changed.ts"),
        "const token = getToken();\nconst DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;\n",
    )
    .unwrap();
    git(&workspace(&fixture), &["add", "changed.ts"]);
    git(
        &workspace(&fixture),
        &["commit", "-qm", "fixture code references"],
    );
    let (_, mut visual) = open_commit(&fixture, cx);
    assert!(
        visual.debug_bounds("commit-editor").is_some(),
        "code references without credential values must remain editable"
    );
}

#[gpui::test]
fn punctuated_password_assignments_never_reach_commit_frame_or_clipboard(cx: &mut TestAppContext) {
    let canary = ["owned", "commit@value!"].join("-");
    for source in [
        format!("DATABASE_PASSWORD={canary}\n"),
        "DATABASE_PASSWORD='!@'\n".into(),
    ] {
        let fixture = Fixture::new();
        fs::write(workspace(&fixture).join("changed.ts"), source).unwrap();
        let (shell, mut visual) = open_commit(&fixture, cx);
        visual.write_to_clipboard(gpui::ClipboardItem::new_string("safe clipboard".into()));
        if let Some(editor) = visual.debug_bounds("commit-editor") {
            visual.simulate_click(editor.center(), gpui::Modifiers::default());
            visual.simulate_keystrokes("ctrl-a ctrl-c");
        }
        draw(&mut visual);
        let frame_safe =
            shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
                Some(Content::Commit(view)) => view.read(cx).test_hidden_source(cx),
                _ => false,
            });
        let clipboard_safe = visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .is_some_and(|text| !text.contains(&canary) && !text.contains("!@"));
        let logs_safe = !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains(&canary);
        assert!(
            frame_safe && clipboard_safe && logs_safe,
            "credential assignments must stay outside the editor, painted frame, clipboard and logs"
        );
    }
}

#[gpui::test]
fn retargeted_hex_ref_keeps_header_comparison_and_patch_on_one_commit(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let original = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["tag", "decaf00", &original]);
    let (shell, mut visual) = open_commit(&fixture, cx);
    click(&mut visual, "commit-hash");
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input("decaf00");
    visual.simulate_keystrokes("enter");
    wait_commit(&shell, &mut visual);
    fs::write(root.join("removed.txt"), "other commit snapshot\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-qm", "fixture retarget"]);
    git(&root, &["tag", "-f", "decaf00", "HEAD"]);
    click(&mut visual, "commit-file-1");
    wait_commit(&shell, &mut visual);
    let comparison_bound =
        shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
            Some(Content::Commit(view)) => view.read(cx).test_comparison_bound(&original),
            _ => false,
        });
    click(&mut visual, "commit-patch");
    for _ in 0..30 {
        visual.run_until_parked();
        draw(&mut visual);
        if shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
            Some(Content::Commit(view)) => view.read(cx).test_patch_head(cx).is_some(),
            _ => false,
        }) {
            break;
        }
    }
    let patch_bound = shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
        Some(Content::Commit(view)) => {
            view.read(cx).test_patch_head(cx).as_deref() == Some(original.as_str())
        }
        _ => false,
    });
    assert!(
        comparison_bound && patch_bound,
        "header, comparison and Patch must remain bound to the commit resolved by Open"
    );
}
