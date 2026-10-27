use super::{Composer, Submit};
use gpui::{
    Bounds, ClipboardItem, Entity, EntityInputHandler, Modifiers, MouseButton, MouseDownEvent,
    TestAppContext, UTF16Selection, VisualTestContext,
};
use std::time::Instant;

fn editor(cx: &mut TestAppContext) -> (Entity<Composer>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let input = Composer::new(cx);
        input.focus.focus(window);
        input
    })
}
fn draw(cx: &mut VisualTestContext) {
    for _ in 0..2 {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
    }
}
fn selection(input: &Entity<Composer>, cx: &mut VisualTestContext) -> UTF16Selection {
    input.update_in(cx, |i, window, cx| {
        i.selected_text_range(false, window, cx).unwrap()
    })
}
fn word_key(key: &str) -> String {
    format!(
        "{}-{key}",
        if cfg!(target_os = "macos") {
            "alt"
        } else {
            "ctrl"
        }
    )
}

#[gpui::test]
fn native_word_and_line_moves_select_and_delete(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("first line\nsecond word");
    cx.simulate_keystrokes(&word_key("left"));
    assert_eq!(selection(&input, cx).range, 18..18);
    cx.simulate_keystrokes(&word_key("shift-left"));
    assert_eq!(selection(&input, cx).range, 11..18);
    cx.simulate_keystrokes("right home shift-end");
    assert_eq!(selection(&input, cx).range, 11..22);
    cx.simulate_keystrokes("right");
    cx.simulate_keystrokes(&word_key("backspace"));
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "first line\nsecond "
    );
    cx.simulate_keystrokes("ctrl-z home");
    cx.simulate_keystrokes(&word_key("delete"));
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "first line\n word"
    );
}

#[gpui::test]
fn native_mouse_drag_double_word_triple_line_and_keyboard_selection(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("alpha beta\nnext line");
    draw(cx);
    let at = |index, cx: &mut VisualTestContext| {
        input.update_in(cx, |i, window, cx| {
            i.bounds_for_range(index..index, Bounds::default(), window, cx)
                .unwrap()
                .center()
        })
    };
    let start = at(0, cx);
    let end = at(5, cx);
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    assert_eq!(selection(&input, cx).range, 0..5);
    let position = at(7, cx);
    cx.simulate_event(MouseDownEvent {
        position,
        button: MouseButton::Left,
        click_count: 2,
        ..Default::default()
    });
    cx.simulate_mouse_up(position, MouseButton::Left, Modifiers::default());
    assert_eq!(selection(&input, cx).range, 6..10);
    cx.simulate_event(MouseDownEvent {
        position,
        button: MouseButton::Left,
        click_count: 3,
        ..Default::default()
    });
    cx.simulate_mouse_up(position, MouseButton::Left, Modifiers::default());
    assert_eq!(selection(&input, cx).range, 0..11);
    cx.simulate_keystrokes("right shift-left shift-left");
    assert_eq!(selection(&input, cx).range, 9..11);
}

#[gpui::test]
fn native_undo_redo_restores_reversed_selection(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("abc🦀def");
    cx.simulate_keystrokes("shift-left shift-left shift-left");
    assert!(selection(&input, cx).reversed);
    cx.simulate_input("replacement");
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(selection(&input, cx).range, 5..8);
    assert!(
        selection(&input, cx).reversed,
        "undo preserves the active selection end"
    );
    cx.simulate_keystrokes("ctrl-y");
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "abc🦀replacement"
    );
    cx.simulate_keystrokes("ctrl-z");
    cx.simulate_input("new");
    cx.simulate_keystrokes("ctrl-shift-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "abc🦀new");
}

#[gpui::test]
fn native_copy_cut_paste_megabyte_and_empty_copy(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.write_to_clipboard(ClipboardItem::new_string("keep clipboard".into()));
    cx.simulate_keystrokes("ctrl-c ctrl-x");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "keep clipboard"
    );
    let text = "0123456789abcdef\n".repeat(61_680) + &"x".repeat(16);
    assert_eq!(text.len(), 1024 * 1024);
    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
    cx.simulate_keystrokes("ctrl-v");
    draw(cx);
    input.read_with(cx, |i, _| {
        assert_eq!(i.text, text);
        assert_eq!(i.revision, i.painted);
    });
    cx.simulate_keystrokes("ctrl-a ctrl-c ctrl-x");
    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), text);
    assert!(input.read_with(cx, |i, _| i.text.is_empty()));
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.len()), 1024 * 1024);
}

#[gpui::test]
fn native_ime_utf16_replacement_is_one_undo_and_never_submits(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("a🦀z");
    let count = std::rc::Rc::new(std::cell::Cell::new(0));
    let observed = count.clone();
    let _subscription = cx.update(|_, cx| {
        cx.subscribe(&input, move |_, _: &Submit, _| {
            observed.set(observed.get() + 1)
        })
    });
    input.update_in(cx, |i, window, cx| {
        i.replace_and_mark_text_in_range(Some(1..3), "に", Some(1..1), window, cx);
        i.replace_and_mark_text_in_range(None, "日本", Some(2..2), window, cx);
        assert_eq!(i.marked_text_range(window, cx), Some(1..3));
    });
    cx.simulate_keystrokes("enter ctrl-enter left backspace");
    assert_eq!(count.get(), 0);
    input.update_in(cx, |i, window, cx| {
        i.replace_text_in_range(None, "日本語", window, cx)
    });
    draw(cx);
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "a🦀z");
    cx.simulate_keystrokes("ctrl-shift-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "a日本語z");
}

#[gpui::test]
fn native_rtl_mixed_text_selection_clipboard_and_utf16_hit_testing(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    let text = "مرحبا שלום 🦀 abc";
    cx.simulate_input(text);
    draw(cx);
    cx.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(selection(&input, cx).range, 0..text.encode_utf16().count());
    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), text);
    input.update_in(cx, |i, window, cx| {
        let end = text.encode_utf16().count();
        let bounds = i
            .bounds_for_range(end..end, Bounds::default(), window, cx)
            .unwrap();
        assert_eq!(
            i.character_index_for_point(bounds.origin, window, cx),
            Some(end)
        );
    });
    cx.simulate_keystrokes("backspace ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), text);
}

#[gpui::test]
fn native_focus_change_ends_mouse_drag(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("keep this selection");
    draw(cx);
    let bounds = cx.debug_bounds("composer-input").unwrap();
    cx.simulate_mouse_down(bounds.center(), MouseButton::Left, Modifiers::default());
    let before = selection(&input, cx).range;
    cx.update(|window, _| window.blur());
    cx.simulate_mouse_move(bounds.origin, Some(MouseButton::Left), Modifiers::default());
    assert_eq!(
        selection(&input, cx).range,
        before,
        "a blurred field cannot keep dragging"
    );
}

#[gpui::test]
fn native_key_to_cpu_paint_measurement(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    draw(cx);
    let mut samples = vec![];
    for _ in 0..100 {
        let start = Instant::now();
        cx.simulate_input("a");
        draw(cx);
        input.read_with(cx, |i, _| assert_eq!(i.revision, i.painted));
        samples.push(start.elapsed().as_secs_f64() * 1000.);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "COMPOSER_CPU_PAINT platform={} samples=100 p50_ms={:.6} p95_ms={:.6}",
        std::env::consts::OS,
        samples[49],
        samples[94]
    );
}

#[gpui::test]
fn native_nonempty_input_range_exposes_selection_bounds(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("שלום abc");
    draw(cx);
    input.update_in(cx, |i, window, cx| {
        let range = i
            .bounds_for_range(0..4, Bounds::default(), window, cx)
            .unwrap();
        assert!(
            range.size.width > gpui::px(2.),
            "native marked/selected ranges need their text bounds"
        );
        let caret = i
            .bounds_for_range(0..0, Bounds::default(), window, cx)
            .unwrap();
        assert_eq!(caret.size.width, gpui::px(1.));
    });
}

#[gpui::test]
fn native_single_line_megabyte_selection_copy_and_undo(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    let text = "a".repeat(1024 * 1024);
    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
    cx.simulate_keystrokes("ctrl-v ctrl-a ctrl-c");
    draw(cx);
    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), text);
    cx.simulate_keystrokes("backspace ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.len()), text.len());
    draw(cx);
    input.read_with(cx, |i, _| assert_eq!(i.revision, i.painted));
}

#[gpui::test]
fn native_review_word_dispatch_survives_focus_and_unicode(cx: &mut TestAppContext) {
    let (input, cx) = editor(cx);
    cx.simulate_input("🦀 first second\nlast line");
    cx.update(|window, _| window.blur());
    input.update_in(cx, |i, window, _| i.focus.focus(window));
    draw(cx);
    cx.simulate_keystrokes(&word_key("left"));
    assert_eq!(
        selection(&input, cx).range,
        21..21,
        "the active dispatcher must move by word after refocus"
    );
    cx.simulate_keystrokes(&word_key("shift-left"));
    assert_eq!(selection(&input, cx).range, 16..21);
    cx.simulate_keystrokes("backspace ctrl-z");
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "🦀 first second\nlast line"
    );
    cx.simulate_keystrokes("right");
    cx.simulate_keystrokes(&word_key("delete"));
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "🦀 first second\nlast "
    );
}
