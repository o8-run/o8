//! Review regressions through committed fixture lanes and rendered GPUI controls.
use super::*;
#[gpui::test]
fn committed_packet_uses_lane_base_and_enables_merge(cx: &mut TestAppContext) {
    let mut fixture = Fixture::mode(false, false, true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("committed.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("i n l i n e space d i f f enter");
    wait_inline(&shell, &mut visual);
    // A clean committed worktree has no uncommitted changes before packet selection.
    assert!(shell.read_with(&visual, |s,cx| matches!(s.content.get(&s.key(&Tab::InlineDiff)),Some(Content::InlineDiff(v)) if v.read(cx).document.files.is_empty())));
    let input = visual.debug_bounds("inline-packet").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_input("next-inline");
    draw(&mut visual);
    let choose = visual.debug_bounds("inline-open-packet").unwrap();
    let started = Instant::now();
    visual.simulate_click(choose.center(), gpui::Modifiers::default());
    wait_inline(&shell, &mut visual);
    let elapsed = started.elapsed().as_secs_f64() * 1000.;
    shell.read_with(&visual, |s,cx| {
        let Some(Content::InlineDiff(view)) = s.content.get(&s.key(&Tab::InlineDiff)) else {panic!("Diff tab")};
        let view = view.read(cx);
        assert_eq!(view.document.files.len(), 2, "committed packet must show changes against its lane base");
        assert!(matches!(&view.target, crate::diff::Target::Worktree {base:Some(base),..} if base=="fixture-base"));
    });
    let base = visual.debug_bounds("inline-base").unwrap();
    visual.simulate_click(base.center(), gpui::Modifiers::default());
    visual.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("fixture-base"),
        "the Base input must show the effective lane comparison"
    );
    let compare = visual.debug_bounds("inline-compare").unwrap();
    visual.simulate_click(compare.center(), gpui::Modifiers::default());
    wait_inline(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s,cx| matches!(s.content.get(&s.key(&Tab::InlineDiff)),Some(Content::InlineDiff(v)) if v.read(cx).document.files.len()==2)));
    let merge = visual.debug_bounds("inline-merge").unwrap();
    visual.simulate_click(merge.center(), gpui::Modifiers::default());
    wait_inline(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s,cx| matches!(s.content.get(&s.key(&Tab::InlineDiff)),Some(Content::InlineDiff(v)) if !v.read(cx).notice.contains("No changes"))));
    // Flush the fixture's request log and prove the enabled control reached the real merge gate.
    let receipt = fixture
        .client
        .get::<Value>("/api/orchestrator/inline-fixture-log", &[])
        .unwrap();
    Process::new("kill")
        .args(["-TERM", &fixture.server.id().to_string()])
        .status()
        .unwrap();
    fixture.server.wait().unwrap();
    assert!(
        receipt["requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "POST /api/orchestrator/merge")
    );
    let mutation = &receipt["mutation"];
    assert_eq!(mutation["packetId"], "next-inline");
    let head = shell.read_with(&visual, |s, cx| {
        match s.content.get(&s.key(&Tab::InlineDiff)) {
            Some(Content::InlineDiff(v)) => v.read(cx).document.head.clone(),
            _ => panic!("Diff"),
        }
    });
    assert_eq!(
        mutation["expectedHeadSha"], head,
        "Merge carries the exact revision read and stable packet ID"
    );

    println!(
        "O8_NEXT_PACKET_EVIDENCE {}",
        json!({"openToFirstFrameMs":elapsed,"committedFiles":2,"baseBranch":"fixture-base"})
    );
}
#[gpui::test]
fn inline_diff_omits_standalone_title_and_mode_controls(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("title.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("i n l i n e space d i f f enter");
    wait_inline(&shell, &mut visual);
    assert!(
        visual.debug_bounds("diff-title").is_none(),
        "Diff tab already supplies the inline title"
    );
    assert!(
        visual.debug_bounds("diff-refresh").is_some(),
        "Refresh remains reachable"
    );
    assert!(visual.debug_bounds("diff-unified").is_none());
    assert!(visual.debug_bounds("diff-split").is_none());
    let path = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let (_, standalone) = cx.add_window_view(|window, cx| {
        crate::diff_ui::DiffSurface::new(
            fixture.client.clone(),
            crate::diff::Target::Worktree {
                path: path.to_string_lossy().into(),
                base: None,
                file: None,
            },
            window,
            cx,
        )
    });
    draw(standalone);
    assert!(standalone.debug_bounds("diff-unified").is_some());
    assert!(standalone.debug_bounds("diff-split").is_some());
}
