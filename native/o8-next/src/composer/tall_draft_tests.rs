use super::*;

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    for _ in 0..3 {
        cx.update(|window, cx| window.draw(cx).clear());
    }
    // Cached sibling scenes do not repopulate GPUI's per-frame debug map.
    // Inspect fresh bounds after the ordinary editor frames have settled.
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn reveal_tail(surface: &gpui::Entity<Surface>, cx: &mut VisualTestContext) {
    surface.update(cx, |s, cx| {
        s.list.scroll_to_reveal_item(s.list.item_count() - 1);
        s.pinned = true;
        cx.notify();
    });
    settle(cx);
    last_row_above_composer(cx);
}

fn last_row_above_composer(cx: &mut VisualTestContext) {
    // loaded() verifies that all 200 fixture messages reached the real list.
    let row = cx
        .debug_bounds("transcript-row-199")
        .expect("last transcript row");
    let card = cx.debug_bounds("composer-card").unwrap();
    let viewport = cx.debug_bounds("transcript-viewport").unwrap();
    let space = cx.debug_bounds("composer-space").unwrap();
    assert!(
        row.bottom() <= card.top(),
        "last row {row:?} overlaps composer {card:?}; transcript {viewport:?}; reserved composer space {space:?}"
    );
}

fn caret_inside_input(surface: &gpui::Entity<Surface>, cx: &mut VisualTestContext) {
    let viewport = cx.debug_bounds("composer-input").unwrap();
    let card = cx.debug_bounds("composer-card").unwrap();
    surface.update_in(cx, |s, window, cx| {
        s.composer.update(cx, |i, cx| {
            let cursor = i.text[..i.cursor()].encode_utf16().count();
            let caret = gpui::EntityInputHandler::bounds_for_range(
                i,
                cursor..cursor,
                gpui::Bounds::default(),
                window,
                cx,
            )
            .expect("native caret bounds");
            assert!(
                caret.top() >= viewport.top() && caret.bottom() <= viewport.bottom(),
                "cursor line {caret:?} outside input {viewport:?}"
            );
            assert!(caret.top() >= card.top() && caret.bottom() <= card.bottom());
        });
    });
}

#[gpui::test]
fn native_composer_tall_draft_15_lines_yields_transcript_space(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    reveal_tail(&surface, cx);
    let before = cx.debug_bounds("composer-card").unwrap();
    let space = cx.debug_bounds("composer-space").unwrap();
    let transcript = cx.debug_bounds("transcript-viewport").unwrap();
    cx.simulate_input("draft line 1");
    for line in 2..=15 {
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input(&format!("draft line {line}"));
    }
    settle(cx);
    let after = cx.debug_bounds("composer-card").unwrap();
    assert!(after.size.height > before.size.height);
    assert_eq!(
        after.bottom(),
        before.bottom(),
        "card stays bottom anchored"
    );
    last_row_above_composer(cx);
    assert!(cx.debug_bounds("composer-space").unwrap().size.height > space.size.height);
    assert_eq!(
        transcript.size.height - cx.debug_bounds("transcript-viewport").unwrap().size.height,
        after.size.height - before.size.height,
        "the transcript yields exactly the height gained by the composer"
    );
    caret_inside_input(&surface, cx);
    // Background session updates must preserve the geometry reached by typing.
    surface.update(cx, |_, cx| cx.notify());
    settle(cx);
    last_row_above_composer(cx);
    assert_eq!(cx.debug_bounds("composer-card").unwrap(), after);
    cx.simulate_keystrokes("ctrl-a backspace");
    settle(cx);
    assert_eq!(cx.debug_bounds("composer-card").unwrap(), before);
}

#[gpui::test]
fn native_composer_tall_draft_60_lines_caps_and_reveals_cursor(cx: &mut TestAppContext) {
    let fixture = Fixture::with_loaded(true);
    let (surface, cx) = loaded(cx, &fixture);
    reveal_tail(&surface, cx);
    let before = cx.debug_bounds("composer-card").unwrap();
    let chrome = before.size.height - cx.debug_bounds("composer-input").unwrap().size.height;
    // Exercise the production handler for the shell strip's Add to chat.
    surface.update(cx, |s, cx| {
        s.add_shell_output(
            "print-output",
            Some(crate::terminal_grid::CommandOutput {
                lines: (1..=55).map(|n| format!("output line {n}")).collect(),
                finished: true,
            }),
            cx,
        );
        assert_eq!(s.composer.read(cx).text.split('\n').count(), 60);
    });
    settle(cx);
    assert_eq!(
        cx.debug_bounds("composer-input").unwrap().size.height,
        px(200.)
    );
    let card = cx.debug_bounds("composer-card").unwrap();
    assert_eq!(card.size.height, px(200.) + chrome);
    assert_eq!(card.bottom(), before.bottom());
    caret_inside_input(&surface, cx);
    last_row_above_composer(cx);
    surface.update(cx, |_, cx| cx.notify());
    settle(cx);
    last_row_above_composer(cx);
    assert_eq!(cx.debug_bounds("composer-card").unwrap(), card);
    for key in ["ctrl-home", "ctrl-end"] {
        cx.simulate_keystrokes(key);
        settle(cx);
        caret_inside_input(&surface, cx);
        assert_eq!(cx.debug_bounds("composer-card").unwrap(), card);
    }
    cx.simulate_resize(gpui::size(px(900.), px(700.)));
    settle(cx);
    assert_eq!(
        cx.debug_bounds("composer-input").unwrap().size.height,
        px(196.)
    );
    caret_inside_input(&surface, cx);
    last_row_above_composer(cx);
}
