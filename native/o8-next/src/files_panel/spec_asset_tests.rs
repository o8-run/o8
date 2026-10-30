//! Actual clipboard/Finder-drop events, production asset writes and text menu.
use super::*;
use base64::Engine;
use gpui::{ClipboardItem, ExternalPaths, FileDropEvent, Image, ImageFormat, MouseButton};
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAVklEQVR4nO3PAQ3AIADAMEAOnlCOmbv4k71VsM197viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UPI0QBwum7oOkAAAAASUVORK5CYII=").unwrap()
}
#[gpui::test]
fn spec_image_clipboard_upload_preview_and_autosave(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "# Image fixture\n\n").unwrap();
    fs::write(f.root.join("save-delay-ms"), "150").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    click(cx, "spec-editor");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-end"
    } else {
        "ctrl-end"
    });
    cx.update(|_, cx| {
        cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
            ImageFormat::Png,
            png(),
        )))
    });
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-v"
    } else {
        "ctrl-v"
    });
    draw(cx);
    assert!(content(cx).contains("Uploading image…") || content(cx).contains("o8-assets/"));
    cx.simulate_input("Keep typing after the image.");
    draw(cx);
    until(cx, |cx| {
        content(cx).contains("o8-assets/") && !content(cx).contains("Uploading image…")
    });
    assert!(content(cx).contains("Keep typing after the image."));
    cx.simulate_input(" More text.");
    draw(cx);
    assert!(
        content(cx).contains("Keep typing after the image. More text."),
        "upload completion preserves the typing caret"
    );
    wait(cx, "spec-inline-image-loaded");
    let thumb = cx.debug_bounds("spec-inline-image").unwrap();
    assert_eq!(thumb.size.height, px(120.));
    assert!(thumb.size.width <= px(280.));
    advance(cx, 810);
    until(cx, |cx| !cx.update(|_, cx| cx.global::<Status>().pending));
    assert_eq!(fs::read_to_string(path(&f)).unwrap(), content(cx));
    let files = fs::read_dir(PathBuf::from(&f.repo).join("o8-assets"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(fs::read(files[0].path()).unwrap(), png());
    assert!(!content(cx).contains("base64"));
    assert!(
        content(cx).contains("\"80x48\""),
        "inline refs reserve their measured image ratio"
    );
}
#[gpui::test]
fn spec_image_finder_drop_and_failed_upload_feedback(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "Drop here.\n").unwrap();
    let dropped = f.root.join("dropped.png");
    fs::write(&dropped, png()).unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    let position = cx.debug_bounds("spec-editor").unwrap().center();
    cx.simulate_event(FileDropEvent::Entered {
        position,
        paths: ExternalPaths::new([dropped]),
    });
    draw(cx);
    cx.simulate_event(FileDropEvent::Submit { position });
    draw(cx);
    until(cx, |cx| content(cx).contains("o8-assets/"));
    wait(cx, "spec-inline-image-loaded");
    let svg = f.root.join("inline.svg");
    fs::write(&svg,r##"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="48"><rect width="80" height="48" fill="#ec6737"/></svg>"##).unwrap();
    cx.simulate_event(FileDropEvent::Entered {
        position,
        paths: ExternalPaths::new([svg]),
    });
    draw(cx);
    cx.simulate_event(FileDropEvent::Submit { position });
    draw(cx);
    until(cx, |cx| content(cx).contains(".svg"));
    wait(cx, "spec-inline-svg-loaded");
    // The dropped file disappeared before the server could read it.
    let bad = f.root.join("unreadable.png");
    cx.simulate_event(FileDropEvent::Entered {
        position,
        paths: ExternalPaths::new([bad]),
    });
    draw(cx);
    cx.simulate_event(FileDropEvent::Submit { position });
    draw(cx);
    wait(cx, "spec-image-error");
    until(cx, |cx| !content(cx).contains("Uploading image…"));
    assert_eq!(
        fs::read_dir(PathBuf::from(&f.repo).join("o8-assets"))
            .unwrap()
            .count(),
        2
    );
}
#[gpui::test]
fn spec_text_context_menu_and_atomic_markup_keyboard(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(
        path(&f),
        "# Notes\n\n{++Suggestion++}{id=\"s1\" by=\"AI\"}\n",
    )
    .unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "note-s1");
    click(cx, "spec-editor");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-home right backspace"
    } else {
        "ctrl-home right backspace"
    });
    draw(cx);
    assert!(
        content(cx).starts_with("Notes\n"),
        "hidden heading markers are a single editing unit"
    );
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    draw(cx);
    let position = cx.debug_bounds("spec-editor").unwrap().center();
    cx.simulate_mouse_down(position, MouseButton::Right, gpui::Modifiers::default());
    cx.simulate_mouse_up(position, MouseButton::Right, gpui::Modifiers::default());
    draw(cx);
    wait(cx, "notes-text-menu");
    click(cx, "notes-text-select-all");
    cx.simulate_input("Replacement via the native menu");
    draw(cx);
    assert_eq!(content(cx), "Replacement via the native menu");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    draw(cx);
    assert!(content(cx).contains("{++Suggestion++}"));
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-end left backspace"
    } else {
        "ctrl-end left backspace"
    });
    draw(cx);
    let updated = content(cx);
    assert!(
        !updated.contains("{id=\"s1\" by=\"AI\""),
        "deletion crosses hidden metadata atomically"
    );
    assert!(!updated.contains("id=\"s1\" b"));
}

#[gpui::test]
fn spec_unregistered_target_image_preview_keeps_projects_unchanged(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let folder = f.root.join("home/unregistered-notes");
    fs::create_dir_all(folder.join("o8-assets")).unwrap();
    fs::write(folder.join("o8-assets/image.png"), png()).unwrap();
    fs::write(
        folder.join("o8.md"),
        "# Unregistered notes\n\n![Image](o8-assets/image.png \"80x48\")\n",
    )
    .unwrap();
    let mut state = super::preferences::empty_state();
    state["notes"] = serde_json::json!({"target_override":folder});
    let mut cx = super::preferences::shell(&f, state, cx);
    wait(&mut cx, "spec-inline-image-loaded");
    assert!(
        f.requests()
            .iter()
            .any(|r| r.starts_with("GET /api/panel/serve-image?path="))
    );
    assert!(
        !f.requests()
            .iter()
            .any(|r| r.starts_with("POST /api/panel/repos"))
    );
    let registry: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("data/repos.json")).unwrap()).unwrap();
    assert_eq!(registry["repos"].as_array().unwrap().len(), 1);
}
