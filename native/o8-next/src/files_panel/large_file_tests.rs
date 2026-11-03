//! Large-file receipt: open, scroll, edit and highlight cost at 10k, 100k and 1M lines.
use super::*;

pub(super) struct Receipt {
    pub lines: usize,
    pub open_ms: f64,
    pub highlight_ms: f64,
    pub scroll_middle_ms: f64,
    pub scroll_end_ms: f64,
    pub edit_open_ms: f64,
    pub edit_scroll_middle_ms: f64,
    pub edit_scroll_end_ms: f64,
    pub key_p95_ms: f64,
    pub backspace_p95_ms: f64,
}

pub(super) fn generate(lines: usize) -> String {
    let mut text = String::with_capacity(lines * 48);
    for i in 0..lines {
        use std::fmt::Write;
        let _ = writeln!(text, "    let value_{i} = compute({i}, \"row\"); // line");
    }
    text.pop();
    text
}

fn frame(cx: &mut VisualTestContext) -> f64 {
    let start = Instant::now();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    start.elapsed().as_secs_f64() * 1000.
}

fn p95(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[((samples.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)]
}

fn editor(panel: &Entity<FilesPanel>, cx: &mut VisualTestContext) -> Entity<editor::Editor> {
    panel.read_with(cx, |p, _| match &p.file {
        File::Loaded { buffer, .. } => buffer.editor.clone(),
        _ => panic!("file must be loaded"),
    })
}

/// Drives the production FilesPanel viewer and editor through one file size.
pub(super) fn measure(lines: usize, cx: &mut TestAppContext) -> Receipt {
    let content = generate(lines);
    let middle_byte = content.len() / 2;
    let middle_byte = middle_byte + content[middle_byte..].find('\n').unwrap_or(0);
    let (panel, cx) = cx.add_window_view(|_, cx| {
        FilesPanel::new(
            Client::new("http://127.0.0.1:9").unwrap(),
            "/large-file-receipt".into(),
            Mode::Files,
            cx,
        )
    });
    cx.simulate_resize(gpui::size(px(1200.), px(816.)));
    cx.run_until_parked();
    frame(cx);

    // Open: buffer load, line split and the first painted frame.
    let start = Instant::now();
    panel.update(cx, |p, cx| {
        p.selected = Some("large.rs".into());
        p.file_generation += 1;
        p.file = p.loaded_file(&content, false, None, None, cx);
        p.watch_editor(cx);
    });
    frame(cx);
    let open_ms = start.elapsed().as_secs_f64() * 1000.;
    assert!(cx.debug_bounds("files-source-line-1-0").is_some());
    assert_eq!(
        cx.debug_bounds("files-large").is_some(),
        lines > 300_000,
        "only files past the syntax cap explain the missing colors"
    );

    // Whole-file syntax work. Production runs it on the background executor.
    let start = Instant::now();
    cx.run_until_parked();
    let highlight_ms = start.elapsed().as_secs_f64() * 1000.;
    frame(cx);

    let scroll = |cx: &mut VisualTestContext, item_ix: usize| {
        panel.update(cx, |p, _| {
            if let File::Loaded { source, .. } = &p.file {
                // reveal_line keeps two lines of context above the 1-based line.
                source.reveal_line(item_ix + 3);
            }
        });
        frame(cx)
    };
    let scroll_middle_ms = scroll(cx, lines / 2);
    let scroll_end_ms = scroll(cx, lines - 1);
    assert!(
        cx.debug_bounds(Box::leak(
            format!("files-source-line-1-{}", lines - 1).into_boxed_str()
        ))
        .is_some(),
        "the last line must paint"
    );

    // Edit mode: the same buffer in the native textarea.
    let editor = editor(&panel, cx);
    let start = Instant::now();
    panel.update_in(cx, |p, window, cx| p.toggle_edit(window, cx));
    frame(cx);
    let edit_open_ms = start.elapsed().as_secs_f64() * 1000.;
    editor.update(cx, |e, _| e.scroll_to_y(px((lines / 2) as f32 * 19.)));
    let edit_scroll_middle_ms = frame(cx);
    editor.update(cx, |e, _| e.scroll_to_y(px(lines as f32 * 19.)));
    let edit_scroll_end_ms = frame(cx);

    editor.update(cx, |e, cx| e.place_cursor(middle_byte, cx));
    frame(cx);
    frame(cx);
    let before = editor.read_with(cx, |e, _| e.text.len());
    let mut keys = vec![];
    for _ in 0..20 {
        let start = Instant::now();
        cx.simulate_input("a");
        frame(cx);
        keys.push(start.elapsed().as_secs_f64() * 1000.);
    }
    let mut backspaces = vec![];
    for _ in 0..20 {
        let start = Instant::now();
        cx.simulate_keystrokes("backspace");
        frame(cx);
        backspaces.push(start.elapsed().as_secs_f64() * 1000.);
    }
    editor.read_with(cx, |e, _| {
        assert_eq!(e.text.len(), before, "typed then deleted 20 characters");
        assert_eq!(e.text, content);
    });
    Receipt {
        lines,
        open_ms,
        highlight_ms,
        scroll_middle_ms,
        scroll_end_ms,
        edit_open_ms,
        edit_scroll_middle_ms,
        edit_scroll_end_ms,
        key_p95_ms: p95(keys),
        backspace_p95_ms: p95(backspaces),
    }
}

pub(super) fn read_only_above_the_cap(cx: &mut TestAppContext) {
    assert_eq!(source::Large::of(300_000, 1 << 20), source::Large::No);
    assert_eq!(source::Large::of(300_001, 1 << 20), source::Large::Plain);
    assert_eq!(source::Large::of(10, 21 << 20), source::Large::Plain);
    assert_eq!(
        source::Large::of(2_000_001, 1 << 20),
        source::Large::ReadOnly
    );
    assert_eq!(source::Large::of(10, 129 << 20), source::Large::ReadOnly);
    let (panel, cx) = cx.add_window_view(|_, cx| {
        FilesPanel::new(
            Client::new("http://127.0.0.1:9").unwrap(),
            "/large-file-receipt".into(),
            Mode::Files,
            cx,
        )
    });
    cx.simulate_resize(gpui::size(px(1200.), px(816.)));
    let content = "\n".repeat(2_000_001);
    panel.update(cx, |p, cx| {
        p.selected = Some("huge.txt".into());
        p.editing_path = p.selected.clone();
        p.file_generation += 1;
        p.file = p.loaded_file(&content, false, None, None, cx);
        p.watch_editor(cx);
    });
    frame(cx);
    assert!(
        cx.debug_bounds("files-large").is_some(),
        "large-file banner"
    );
    assert!(cx.debug_bounds("files-edit-toggle").is_none(), "no Edit");
    assert!(
        cx.debug_bounds("files-editor").is_none(),
        "never opens editing"
    );
    panel.update_in(cx, |p, window, cx| p.toggle_edit(window, cx));
    frame(cx);
    assert!(cx.debug_bounds("files-editor").is_none(), "toggle refuses");
}

#[test]
fn line_index_matches_a_rebuild_after_every_edit() {
    use super::editor::lines::{Lines, units};
    let mut text = String::from("ab\ncé\n\n😀x\nlast");
    let mut lines = Lines::new(&text);
    let inserts = ["", "\n", "é\n😀", "abc", "\n\n", "x"];
    let mut seed = 7u64;
    let mut next = |below: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize % below.max(1)
    };
    for _ in 0..400 {
        let bounds: Vec<usize> = text
            .char_indices()
            .map(|(i, _)| i)
            .chain([text.len()])
            .collect();
        let a = bounds[next(bounds.len())];
        let b = bounds[next(bounds.len())];
        let range = a.min(b)..a.max(b);
        let new = inserts[next(inserts.len())];
        let removed16 = units(&text[range.clone()]);
        text.replace_range(range.clone(), new);
        lines.edit(&text, range, new, removed16);
        let fresh = Lines::new(&text);
        assert_eq!(lines.len(), fresh.len());
        for line in 0..fresh.len() {
            assert_eq!(lines.range(line, text.len()), fresh.range(line, text.len()));
        }
        for (byte, _) in text.char_indices().chain([(text.len(), ' ')]) {
            let u = text[..byte].encode_utf16().count();
            assert_eq!(lines.to_utf16(&text, byte), u);
            assert_eq!(lines.to_byte(&text, u), byte);
        }
    }
}

pub(super) fn undo_steps_restore_each_state(cx: &mut TestAppContext) {
    let original = "fn main() {\n    println!(\"é😀\");\n}\n";
    let (editor, cx) = cx.add_window_view(|_, cx| editor::Editor::new(original, cx));
    cx.update(|window, cx| editor.read(cx).focus.focus(window));
    frame(cx);
    let text = |cx: &mut VisualTestContext| editor.read_with(cx, |e, _| e.text.clone());
    let mut states = vec![original.to_owned()];
    editor.update(cx, |e, cx| e.place_cursor(12, cx));
    frame(cx);
    // Typed characters (one input event each) coalesce into one step.
    cx.simulate_input("let x = 1;ab");
    states.push(text(cx));
    cx.simulate_keystrokes("enter");
    states.push(text(cx));
    cx.simulate_keystrokes("backspace");
    states.push(text(cx));
    cx.simulate_keystrokes("backspace");
    states.push(text(cx));
    let (all, paste, undo, redo) = if cfg!(target_os = "macos") {
        ("cmd-a", "cmd-v", "cmd-z", "cmd-shift-z")
    } else {
        ("ctrl-a", "ctrl-v", "ctrl-z", "ctrl-shift-z")
    };
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("one\ntwo é\n".into()));
    cx.simulate_keystrokes(paste);
    states.push(text(cx));
    cx.simulate_keystrokes(all);
    cx.simulate_input("whole new 😀 text");
    states.push(text(cx));
    assert_eq!(states.last().unwrap(), "whole new 😀 text");
    assert!(states[5].contains("let x = 1;aone\ntwo é\n"));
    for state in states.iter().rev().skip(1) {
        cx.simulate_keystrokes(undo);
        assert_eq!(&text(cx), state);
    }
    for state in states.iter().skip(1) {
        cx.simulate_keystrokes(redo);
        assert_eq!(&text(cx), state);
    }
    frame(cx);
}

pub(super) fn print(receipt: &Receipt) {
    println!(
        "large-file lines={} open={:.1}ms highlight={:.1}ms scroll_mid={:.1}ms scroll_end={:.1}ms \
         edit_open={:.1}ms edit_scroll_mid={:.1}ms edit_scroll_end={:.1}ms key_p95={:.1}ms backspace_p95={:.1}ms",
        receipt.lines,
        receipt.open_ms,
        receipt.highlight_ms,
        receipt.scroll_middle_ms,
        receipt.scroll_end_ms,
        receipt.edit_open_ms,
        receipt.edit_scroll_middle_ms,
        receipt.edit_scroll_end_ms,
        receipt.key_p95_ms,
        receipt.backspace_p95_ms,
    );
}
