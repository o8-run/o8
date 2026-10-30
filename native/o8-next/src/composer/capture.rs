//! Opt-in capture driver for an owned fixture window, never an installed session.
//! Build with macos-diagnostics and set O8_NEXT_COMPOSER_CAPTURE_DIR explicitly.
use super::*;
use gpui::EntityInputHandler;
use objc::{msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::{path::PathBuf, time::Duration};

pub(super) fn start(handle: WindowHandle<Surface>, directory: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if cx.update(|cx| handle.read(cx).unwrap().queue_ready).unwrap() { break; }
            assert!(Instant::now() < deadline, "fixture composer did not become ready");
            cx.background_executor().timer(Duration::from_millis(20)).await;
        }
        handle.update(cx, |s, _, cx| {
            assert!(s.sessions.iter().any(|session| session.id == "thoughts-composer-first"), "capture requires an owned composer fixture");
            s.select("thoughts-composer-first".into(), cx);
        }).unwrap();
        loop {
            if cx.update(|cx| handle.read(cx).unwrap().queue_ready).unwrap() { break; }
            assert!(Instant::now() < deadline, "fixture selection did not become ready");
            cx.background_executor().timer(Duration::from_millis(20)).await;
        }
        handle.update(cx, |s, w, cx| {
            assert_eq!(s.selected.as_deref(), Some("thoughts-composer-first"), "capture requires the disposable composer fixture");
            s.composer.update(cx, |i, cx| {
                i.focus.focus(w);
                i.set_text("", cx);
                i.replace_text_in_range(None, "/", w, cx);
            });
        }).unwrap();
        cx.background_executor().timer(Duration::from_millis(350)).await;
        let (window_id, slash) = handle.update(cx, |s, w, cx| {
            assert!(!s.composer.read(cx).slash_suggestions().is_empty());
            let RawWindowHandle::AppKit(raw) = HasWindowHandle::window_handle(w).unwrap().as_raw() else { panic!("AppKit required") };
            // The NSWindow belongs to this driver; capture never targets another app.
            let ns: *mut objc::runtime::Object = unsafe { msg_send![raw.ns_view.as_ptr() as *mut objc::runtime::Object, window] };
            let id: i64 = unsafe { msg_send![ns, windowNumber] };
            (id, s.composer.read(cx).slash_suggestions().iter().map(|c| c.command).collect::<Vec<_>>())
        }).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let appearance = crate::theme::appearance_name();
        let slash_path = directory.join(format!("{appearance}-slash.png"));
        // A capture requests a complete native frame, independent of damage
        // tracking for an inactive window. Timing is measured by separate tests.
        gpui::AnyWindowHandle::from(handle).update(cx, |_, w, _| w.refresh()).unwrap();
        cx.background_executor().timer(Duration::from_millis(200)).await;
        assert!(Command::new("screencapture").args(["-x", "-l", &window_id.to_string()]).arg(&slash_path).status().unwrap().success());
        gpui::AnyWindowHandle::from(handle).update(cx, |_, w, cx| { w.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx); }).unwrap();
        handle.update(cx, |s, w, cx| {
            assert!(s.composer.read(cx).slash_suggestions().is_empty());
            s.composer.read(cx).controls.focus["composer-mode"].focus(w);
        }).unwrap();
        // Let the focus change repaint before dispatching through the real button.
        cx.background_executor().timer(Duration::from_millis(100)).await;
        gpui::AnyWindowHandle::from(handle).update(cx, |_, w, cx| { w.dispatch_keystroke(Keystroke::parse("enter").unwrap(), cx); }).unwrap();
        cx.background_executor().timer(Duration::from_millis(350)).await;
        let mode = handle.update(cx, |s, _, cx| {
            assert_eq!(s.composer.read(cx).controls.open, Some("mode"));
            json!(s.composer.read(cx).controls.overrides["pickedMode"].as_str().unwrap_or("solo"))
        }).unwrap();
        let mode_path = directory.join(format!("{appearance}-mode.png"));
        gpui::AnyWindowHandle::from(handle).update(cx, |_, w, _| w.refresh()).unwrap();
        cx.background_executor().timer(Duration::from_millis(200)).await;
        assert!(Command::new("screencapture").args(["-x", "-l", &window_id.to_string()]).arg(&mode_path).status().unwrap().success());
        std::fs::write(directory.join(format!("{appearance}.json")), serde_json::to_vec_pretty(&json!({
            "appearance":appearance,"pid":std::process::id(),"window":window_id,
            "slash":slash,"mode":mode,"captures":[slash_path.file_name().unwrap().to_string_lossy(), mode_path.file_name().unwrap().to_string_lossy()],
            "scope":"owned disposable native fixture; GPUI text input and button key dispatch"
        })).unwrap()).unwrap();
        cx.update(|cx| cx.quit()).unwrap();
    }).detach();
}
