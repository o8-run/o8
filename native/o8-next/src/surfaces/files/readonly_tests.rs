//! Read-only split regressions through the real native shell and operator routes.
use super::*;
use gpui::{ClipboardItem, Modifiers};

#[gpui::test]
fn javascript_identity_octal_and_continuation_keys_stay_masked(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for source in [
        r"const value = process['\env'][['PASS','WORD'].join('')];",
        r"const value = process['\145nv'][['PASS','WORD'].join('')];",
        "const value = process['e\\\nnv'][['PASS','WORD'].join('')];",
        r"const value = config['\120ASS' + 'WORD'];",
    ] {
        fs::write(workspace(&fixture).join("escape-forms.ts"), source).unwrap();
        let (shell, mut visual) = open_file("escape-forms.ts", &fixture, cx);
        assert!(
            shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                Some(Content::Files(view)) => view.read(cx).test_hidden_source(cx),
                _ => false,
            }),
            "JavaScript key escape semantics must not bypass the read-only mask"
        );
        visual.write_to_clipboard(ClipboardItem::new_string("safe clipboard".into()));
        click(&mut visual, "file-copy");
        assert_eq!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some("safe clipboard")
        );
    }
}

#[gpui::test]
fn wide_source_scrolls_inside_the_read_only_pane(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        workspace(&fixture).join("wide.ts"),
        format!("const message = '{}';\n", "x".repeat(800)),
    )
    .unwrap();
    let (shell, mut visual) = open_file("wide.ts", &fixture, cx);
    let bounds = visual.debug_bounds("file-source").unwrap();
    visual.simulate_event(gpui::ScrollWheelEvent {
        position: bounds.center(),
        delta: gpui::ScrollDelta::Pixels(gpui::point(gpui::px(-500.), gpui::px(0.))),
        ..Default::default()
    });
    draw(&mut visual);
    assert!(
        shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
            Some(Content::Files(view)) => view.read(cx).test_horizontal_scrolled(),
            _ => false,
        }),
        "wide source must remain reachable with horizontal scrolling inside the pane"
    );
}

#[gpui::test]
fn escaped_computed_environment_names_stay_masked(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for source in [
        r"const value = process['\x65nv'][['PASS','WORD'].join('')];",
        r"const value = process['e\u006ev'][['PASS','WORD'].join('')];",
        r"const value = pr\u006fcess.env[['PASS','WORD'].join('')];",
        r"const value = globalThis.process.env[['PASS','WORD'].join('')];",
    ] {
        fs::write(workspace(&fixture).join("escaped.ts"), source).unwrap();
        let (shell, mut visual) = open_file("escaped.ts", &fixture, cx);
        assert!(
            shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                Some(Content::Files(view)) => view.read(cx).test_hidden_source(cx),
                _ => false,
            }),
            "escaped computed environment names must render masked"
        );
        visual.write_to_clipboard(ClipboardItem::new_string("safe clipboard".into()));
        click(&mut visual, "file-copy");
        assert_eq!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some("safe clipboard")
        );
    }
}

#[gpui::test]
fn computed_environment_object_syntax_cannot_evade_masking(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("computed-object.ts");
    for source in [
        "const value = process . env[['PASS', 'WORD'].join('')];\n",
        "const value = (process.env)[['PASS', 'WORD'].join('')];\n",
        "const value = process['env'][['PASS', 'WORD'].join('')];\n",
        "const value = process /* fixture */ . env[`PASS${'WORD'}`];\n",
        "const value = this.env[['PASS', 'WORD'].join('')];\n",
        "const value = (process.env as Record<string, string>)[['PASS', 'WORD'].join('')];\n",
        "const value = Object.assign({}, process.env)[['PASS', 'WORD'].join('')];\n",
    ] {
        fs::write(&file, source).unwrap();
        let (shell, mut visual) = open_file("computed-object.ts", &fixture, cx);
        assert!(
            shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
                Some(Content::Files(view)) => view.read(cx).test_hidden_source(cx),
                _ => false,
            }),
            "equivalent computed environment object syntax must render masked"
        );
        visual.write_to_clipboard(ClipboardItem::new_string("safe clipboard".into()));
        click(&mut visual, "file-copy");
        assert_eq!(
            visual
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref(),
            Some("safe clipboard")
        );
    }
}

#[gpui::test]
fn computed_environment_key_is_masked_before_frame_or_copy(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let source = "const value = process.env['PASS' + 'WORD'];\n";
    fs::write(workspace(&fixture).join("computed.ts"), source).unwrap();
    let (shell, mut visual) = open_file("computed.ts", &fixture, cx);
    assert!(
        shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
            Some(Content::Files(view)) => view.read(cx).test_hidden_source(cx),
            _ => false,
        }),
        "computed credential access must render masked before entering a frame"
    );
    assert!(
        visual.debug_bounds("file-masked").is_some(),
        "the read-only frame must show an explicit mask"
    );
    visual.write_to_clipboard(ClipboardItem::new_string("safe clipboard".into()));
    let copy = visual
        .debug_bounds("file-copy")
        .expect("read-only Copy control");
    visual.simulate_click(copy.center(), Modifiers::default());
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("safe clipboard")
    );
    assert_eq!(
        fs::read_to_string(workspace(&fixture).join("computed.ts")).unwrap(),
        source
    );
    visual.simulate_keystrokes("ctrl-tab");
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))));
    for _ in 0..8 {
        visual.simulate_keystrokes("ctrl-tab");
        draw(&mut visual);
        if shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))) {
            break;
        }
    }
    assert!(shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))));
    visual.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("computed.ts"),
        "returning to masked source must focus the rendered path field"
    );
}

#[gpui::test]
fn source_has_no_edit_paste_or_save_path(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let source = "export const greeting = 'Hello';\n";
    let file = workspace(&fixture).join("source.ts");
    fs::write(&file, source).unwrap();
    let (shell, mut visual) = open_file("source.ts", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_none() && visual.debug_bounds("file-save").is_none(),
        "read-only source must expose no editor or Save control"
    );
    let view = visual
        .debug_bounds("file-source")
        .expect("read-only syntax surface");
    visual.simulate_click(view.center(), Modifiers::default());
    visual.write_to_clipboard(ClipboardItem::new_string(
        "DATABASE_PASSWORD=owned-paste@!".into(),
    ));
    visual.simulate_keystrokes("ctrl-v");
    for key in ["v", "s"] {
        visual.simulate_event(gpui::KeyDownEvent {
            keystroke: gpui::Keystroke {
                modifiers: gpui::Modifiers {
                    platform: true,
                    ..Default::default()
                },
                key: key.into(),
                key_char: None,
            },
            is_held: false,
        });
    }
    visual.simulate_input("owned input");
    visual.simulate_keystrokes("ctrl-s");
    draw(&mut visual);
    assert!(
        shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
            Some(Content::Files(view)) => view.read(cx).test_path_input_matches_source(cx),
            _ => false,
        }),
        "source paste and typing must not leak into the path field"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), source);
    let copy = visual.debug_bounds("file-copy").expect("Copy source");
    visual.simulate_click(copy.center(), Modifiers::default());
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some(source)
    );
}
