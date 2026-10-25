use super::*;
#[gpui::test]
fn inline_boundary_canary_never_reaches_cells_clipboard_or_logs(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let canary = ["fixture-private", "inline-canary"].join("-");
    fs::write(
        root.join("changed.ts"),
        format!("token = {canary}\nhttps://user:{canary}@example.invalid/path\n"),
    )
    .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("boundary.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("d i f f enter");
    for _ in 0..30 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    shell.read_with(&visual, |s, cx| {
        let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else {
            panic!("Diff")
        };
        assert!(
            !v.read(cx).document.source.contains(&canary),
            "sensitive patch bytes must never enter cells or clipboard state"
        );
    });
    let copy = visual.debug_bounds("inline-copy").unwrap();
    visual.simulate_click(copy.center(), gpui::Modifiers::default());
    assert!(
        !visual
            .read_from_clipboard()
            .and_then(|i| i.text())
            .unwrap_or_default()
            .contains(&canary)
    );
    assert!(
        !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains(&canary)
    );
}

#[gpui::test]
fn inline_boundary_very_long_line_is_read_only_before_paint(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    fs::write(root.join("changed.ts"), "x".repeat(300000)).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("large.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("d i f f enter");
    wait_inline(&shell, &mut visual);
    let paint_started = Instant::now();
    draw(&mut visual);
    println!(
        "O8_NEXT_INLINE_LONG_LINE_EVIDENCE {}",
        json!({"sourceBytes":300000,"loadedPaintMs":paint_started.elapsed().as_secs_f64()*1000.})
    );
    shell.read_with(&visual, |s, cx| {
        let Some(Content::Diff(v)) = s.content.get(&s.key(&Tab::Diff)) else {
            panic!("Diff")
        };
        assert!(
            v.read(cx).document.truncated,
            "very long source lines must be read-only before painting"
        );
    });
    visual.write_to_clipboard(gpui::ClipboardItem::new_string("unchanged".into()));
    let copy = visual.debug_bounds("inline-copy").unwrap();
    visual.simulate_click(copy.center(), gpui::Modifiers::default());
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|i| i.text())
            .as_deref(),
        Some("unchanged")
    );
}
