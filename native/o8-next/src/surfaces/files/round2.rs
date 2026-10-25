//! Review round 2 through the real shell, authenticated routes and owned files.
use super::corrections::{edit, open_file, workspace};
use super::*;

#[gpui::test]
fn nonsecret_code_references_remain_editable(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        workspace(&fixture).join("references.ts"),
        "const token = getToken();\nconst DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;\n",
    )
    .unwrap();
    let (_, mut visual) = open_file("references.ts", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_some(),
        "code references without credential values must remain editable"
    );
}

#[gpui::test]
fn punctuated_password_assignments_stay_out_of_painted_content_and_clipboard(
    cx: &mut TestAppContext,
) {
    let canary = ["owned", "punctuated@value!"].join("-");
    for source in [
        format!("DATABASE_PASSWORD={canary}\n"),
        format!("export DATABASE_PASSWORD = {canary} # fixture\n"),
        "DATABASE_PASSWORD='!@'\n".into(),
        "{\"DATABASE_PASSWORD\": \"!@\"}\n".into(),
    ] {
        let fixture = Fixture::new();
        fs::write(workspace(&fixture).join("punctuated.env"), source).unwrap();
        let (shell, mut visual) = open_file("punctuated.env", &fixture, cx);
        visual.write_to_clipboard(gpui::ClipboardItem::new_string("safe clipboard".into()));
        if let Some(editor) = visual.debug_bounds("file-editor") {
            visual.simulate_click(editor.center(), gpui::Modifiers::default());
            visual.simulate_keystrokes("ctrl-a ctrl-c");
        }
        draw(&mut visual);
        let frame_safe =
            shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                Some(Content::Files(view)) => view.read(cx).test_hidden_source(cx),
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
            "secret assignments must stay outside editor, painted frame, clipboard and logs"
        );
    }
}

#[gpui::test]
fn oversized_external_edit_preserves_draft_and_both_conflict_actions(cx: &mut TestAppContext) {
    for reload in [true, false] {
        let fixture = Fixture::new();
        let file = workspace(&fixture).join("external.txt");
        fs::write(&file, "original\n").unwrap();
        let (shell, mut visual) = open_file("external.txt", &fixture, cx);
        edit(&mut visual, "native draft\n");
        fs::write(&file, vec![b'x'; 32 * 1024 * 1024]).unwrap();
        visual.simulate_keystrokes("ctrl-s");
        wait_file(&shell, &mut visual, "external.txt", false);
        assert!(
            visual.debug_bounds("file-reload").is_some()
                && visual.debug_bounds("file-overwrite").is_some(),
            "oversized conflicts must offer Reload and Keep mine without decoding the full response"
        );
        let editor = visual.debug_bounds("file-editor").unwrap();
        visual.simulate_click(editor.center(), gpui::Modifiers::default());
        visual.simulate_keystrokes("ctrl-a ctrl-c");
        assert!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .is_some_and(|text| text == "native draft\n"),
            "conflict must retain the native draft"
        );
        let action = visual
            .debug_bounds(if reload {
                "file-reload"
            } else {
                "file-overwrite"
            })
            .unwrap();
        visual.simulate_click(action.center(), gpui::Modifiers::default());
        wait_file(&shell, &mut visual, "external.txt", reload);
        if reload {
            assert_eq!(fs::metadata(&file).unwrap().len(), 32 * 1024 * 1024);
            assert!(
                shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                    Some(Content::Files(view)) => view.read(cx).test_bounded_readonly(cx),
                    _ => false,
                })
            );
        } else {
            assert_eq!(fs::read_to_string(&file).unwrap(), "native draft\n");
            assert!(
                shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                    Some(Content::Files(view)) => !view.read(cx).has_draft(cx),
                    _ => false,
                }),
                "confirmed Keep mine must clear the draft using a bounded receipt"
            );
        }
    }
}
