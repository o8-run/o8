//! Per-note interaction tests through the native editor and production routes.
use super::*;
const NOTES: &str = "# Fixture notes\n\nThe {==draft line.==}{>>Check the acceptance evidence.<<}{id=\"c1\" by=\"AI\"}\n\n{~~Old wording~>New wording~~}{id=\"s1\" by=\"AI\"}\n\nBody **strong**, *emphasis* and `inline code`.\n";
#[gpui::test]
fn spec_review_markup_rail_and_mixed_typography(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let extra = "\n```md\n{>>code example<<}{id=\"code1\"}\n~~~\n{>>still code<<}{id=\"code2\"}\n```\n\n{==shared anchor==}{>>first<<}{id=\"c3\"}{>>reply<<}{id=\"c4\" re=\"c3\"}{>>second<<}{id=\"c5\"}\n";
    let source = format!("# Café\né {{>>Bare comment<<}}{{by=\"AI\"}}\n\n{NOTES}{extra}");
    fs::write(path(&f), &source).unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "note-c1");
    wait(cx, "note-s1");
    wait(cx, "note-comment-9");
    assert!(
        cx.debug_bounds("note-code1").is_none() && cx.debug_bounds("note-code2").is_none(),
        "fenced code examples are not actionable annotations"
    );
    let index = super::super::super::spec_rfm::parse(&source);
    assert!(
        !index
            .notes
            .iter()
            .any(|n| matches!(n.id.as_str(), "code1" | "code2"))
    );
    assert_eq!(
        index.notes.iter().find(|n| n.id == "c5").unwrap().anchor,
        "shared anchor",
        "replies retain the common anchor for following comments"
    );
    let painted = cx.update(|_, cx| cx.global::<Painted>().0.clone());
    assert!(
        !painted
            .iter()
            .any(|(t, _, _)| t.contains("{>>") || t.contains("id=\"")),
        "review metadata is hidden"
    );
    assert!(
        painted
            .iter()
            .any(|(t, s, _)| t.contains("inline") && *s == 12.),
        "inline monospace is painted at 12px"
    );
    let prose = cx.debug_bounds("spec-editor").unwrap();
    let comment = cx.debug_bounds("note-c1").unwrap();
    let suggestion = cx.debug_bounds("note-s1").unwrap();
    assert!(comment.right() <= prose.right() && comment.size.width == px(134.));
    assert!(
        suggestion.top() >= comment.bottom(),
        "collision spacers keep the rail clear"
    );
    assert!(
        cx.debug_bounds("note-s1-apply").unwrap().left()
            < cx.debug_bounds("note-s1-act").unwrap().left()
    );
    assert!(
        cx.debug_bounds("note-s1-reply").unwrap().left()
            < cx.debug_bounds("note-s1-dismiss").unwrap().left()
    );
    click(cx, "note-comment-9-resolve");
    until(cx, |cx| content(cx).contains("status=\"resolved\""));
    assert_eq!(
        fs::read_to_string(path(&f)).unwrap(),
        content(cx),
        "Unicode fallback IDs match the production parser"
    );
}
#[gpui::test]
fn spec_suggestion_apply_dismiss_and_comment_resolve(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), NOTES).unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "note-s1-apply");
    click(cx, "note-s1-apply");
    until(cx, |cx| {
        content(cx).contains("New wording") && !content(cx).contains("{~~")
    });
    assert_eq!(fs::read_to_string(path(&f)).unwrap(), content(cx));
    assert_eq!(
        puts(&f),
        0,
        "server mutations do not trigger a duplicate PUT"
    );
    click(cx, "note-c1-resolve");
    until(cx, |cx| content(cx).contains("status=\"resolved\""));
    let next = "{++Discard this++}{id=\"s2\" by=\"AI\"}\n";
    replace(cx, next);
    advance(cx, 810);
    until(cx, |cx| !cx.update(|_, cx| cx.global::<Status>().pending));
    wait(cx, "note-s2-dismiss");
    click(cx, "note-s2-dismiss");
    until(cx, |cx| !content(cx).contains("Discard this"));
    assert!(
        !fs::read_to_string(path(&f))
            .unwrap()
            .contains("Discard this")
    );
}
#[gpui::test]
fn spec_scoped_reply_enter_escape_and_error(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), NOTES).unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "note-c1-reply");
    click(cx, "note-c1-reply");
    search(cx, "note-c1-input", "Only this note, please.");
    cx.simulate_keystrokes("enter");
    draw(cx);
    until(cx, |cx| {
        content(cx).contains("Keep this change scoped to the named anchor.")
    });
    let prompt = fs::read_to_string(f.root.join("provider-prompts.jsonl")).unwrap();
    assert!(prompt.contains("Continue one o8.md margin-note thread."));
    assert!(prompt.contains("Only this note, please."));
    assert!(!prompt.contains("Old wording"));
    click(cx, "note-c1-reply");
    search(cx, "note-c1-input", "Retain my failed reply");
    fs::write(f.root.join("provider-error"), "1").unwrap();
    cx.simulate_keystrokes("enter");
    draw(cx);
    wait_requests(cx, &f, |r| {
        r.iter()
            .filter(|r| r.contains("action=scoped-reply"))
            .count()
            == 2
    });
    until(cx, |cx| cx.debug_bounds("note-c1-input").is_some());
    assert_eq!(
        cx.update(|_, cx| cx.global::<Status>().reply.clone())
            .as_deref(),
        Some("Retain my failed reply")
    );
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(cx.update(|_, cx| cx.global::<Status>().reply.is_none()));
    assert!(
        !fs::read_to_string(path(&f))
            .unwrap()
            .contains("Retain my failed reply")
    );
}
#[gpui::test]
fn spec_review_adoption_and_failure(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "# Review fixture\n\nThe draft line.\n").unwrap();
    fs::write(f.root.join("provider-delay-ms"), "250").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-review");
    click(cx, "spec-review");
    until(cx, |cx| {
        content(cx).contains("Check the fixture acceptance evidence.")
    });
    assert_eq!(fs::read_to_string(path(&f)).unwrap(), content(cx));
    fs::write(f.root.join("provider-error"), "1").unwrap();
    click(cx, "spec-review");
    until(cx, |cx| {
        cx.update(|_, cx| {
            cx.global::<Status>()
                .text
                .contains("Fixture review unavailable")
        })
    });
    assert!(cx.debug_bounds("spec-frame").is_some());
}
#[gpui::test]
fn spec_act_reuses_correlated_receipt_and_only_then_resolves(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), NOTES).unwrap();
    fs::write(f.root.join("delegate-progress"), "1").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "note-c1-act");
    click(cx, "note-c1-act");
    until(cx, |cx| {
        content(cx).contains("awaiting approval fixture-approval")
    });
    let bodies: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(f.root.join("delegate-bodies.json")).unwrap())
            .unwrap();
    assert!(bodies.len() >= 2);
    assert_eq!(bodies[0], bodies[1]);
    assert!(bodies[0]["clientMutationId"].as_str().is_some());
    let prompt = bodies[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("Anchor: draft line."));
    assert!(!prompt.contains("Old wording"));
    fs::write(f.root.join("delegate-error"), "1").unwrap();
    click(cx, "note-s1-act");
    wait_requests(cx, &f, |r| {
        r.iter()
            .filter(|r| r.contains("/api/orchestrator/delegate"))
            .count()
            >= 3
    });
    advance(cx, 100);
    assert!(content(cx).contains("{~~Old wording~>New wording~~}"));
}
