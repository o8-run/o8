use super::*;
use base64::Engine;
use gpui::{ClipboardItem, ExternalPaths, FileDropEvent, Image, ImageFormat};

fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAVklEQVR4nO3PAQ3AIADAMEAOnlCOmbv4k71VsM197viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UPI0QBwum7oOkAAAAASUVORK5CYII=").unwrap()
}
fn image_session(cx: &mut VisualTestContext, surface: &gpui::Entity<Surface>) {
    surface.update_in(cx, |s, window, cx| {
        s.routing.as_mut().unwrap()["backend"] = json!("codex");
        s.send_next = true;
        s.composer.read(cx).focus.focus(window);
        cx.notify();
    });
    draw(cx);
}
fn paste(bytes: Vec<u8>, cx: &mut VisualTestContext) {
    cx.update(|_, cx| {
        cx.write_to_clipboard(ClipboardItem::new_image(&Image::from_bytes(
            ImageFormat::Png,
            bytes,
        )))
    });
    cx.simulate_keystrokes("cmd-v");
    cx.run_until_parked();
    draw(cx);
}
fn images(surface: &gpui::Entity<Surface>, cx: &VisualTestContext) -> Vec<Value> {
    surface.read_with(cx, |s, cx| s.composer.read(cx).controls.images.clone())
}

#[gpui::test]
fn native_image_clipboard_cmd_v_and_queue_route(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    image_session(cx, &surface);
    paste(png(), cx);
    let attached = images(&surface, cx);
    assert_eq!(attached.len(), 1, "Cmd+V must attach the clipboard image");
    assert_eq!(
        attached[0]["dataUri"],
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png())
        )
    );
    let bounds = cx.debug_bounds("composer-image-0").expect("thumbnail chip");
    assert!(bounds.size.width > px(0.) && bounds.size.height > px(0.));
    click("send", cx);
    let session = surface.read_with(cx, |s, _| {
        s.sessions
            .iter()
            .find(|s| s.id == "thoughts-composer-first")
            .unwrap()
            .clone()
    });
    let queue = fixture.client.queue(&session).unwrap();
    assert_eq!(queue["items"][0]["payload"]["images"], json!(attached));
    assert_eq!(queue["items"][0]["payload"]["text"], "[Image attached]");
    assert!(images(&surface, cx).is_empty());
}

#[gpui::test]
fn native_image_text_clipboard_keeps_selection_and_newlines(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    image_session(cx, &surface);
    cx.simulate_input("replace me");
    cx.simulate_keystrokes("cmd-a");
    cx.update(|_, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string("first\r\nsecond\rthird".into()))
    });
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "first\nsecond\nthird"
    );
    assert!(images(&surface, cx).is_empty());
}

#[gpui::test]
fn native_image_platform_drop_png_and_remove_before_queue(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    image_session(cx, &surface);
    let path = std::env::temp_dir().join(format!("o8-drop-{}.png", std::process::id()));
    fs::write(&path, png()).unwrap();
    let position = cx.debug_bounds("composer-input").unwrap().center();
    cx.simulate_event(FileDropEvent::Entered {
        position,
        paths: ExternalPaths::new([path.clone()]),
    });
    draw(cx);
    cx.simulate_event(FileDropEvent::Submit { position });
    cx.run_until_parked();
    draw(cx);
    fs::remove_file(path).unwrap();
    assert_eq!(
        images(&surface, cx).len(),
        1,
        "platform PNG drop must attach"
    );
    click("composer-image-remove-0", cx);
    assert!(images(&surface, cx).is_empty());
    click("composer-input", cx);
    cx.simulate_input("Removed image");
    click("send", cx);
    surface.read_with(cx, |s, _| {
        assert_eq!(s.queue["items"][0]["payload"]["images"], json!([]))
    });
}

#[gpui::test]
fn native_image_manual_size_and_four_image_capacity(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    image_session(cx, &surface);
    let mut large = png();
    // Valid PNG with trailing data, above both old native and agent-only caps.
    large.resize(1100 * 1024, 0);
    paste(large.clone(), cx);
    assert_eq!(
        images(&surface, cx).len(),
        1,
        "manual screenshots above 1 MiB retain their original bytes"
    );
    assert_eq!(
        images(&surface, cx)[0]["dataUri"],
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(large)
        )
    );
    for _ in 0..4 {
        paste(png(), cx);
    }
    assert_eq!(images(&surface, cx).len(), 4, "desktop composer cap");
    surface.read_with(cx, |s, cx| {
        assert!(s.composer.read(cx).controls.error.contains("4 images"))
    });
}
