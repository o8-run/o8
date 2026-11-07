//! Real clicks and typing -> Settings › Voice › Polish -> voice-prefs.json.
//! Every test uses its own scratch directory, never this Mac's settings.
use super::*;
use crate::settings::test_peer::*;
use crate::shell::settings::voice_polish::VoicePolish;
use gpui::{Modifiers, TestAppContext, VisualTestContext};
use std::path::{Path, PathBuf};

const SENTINEL: &str = r#"{"gemini_api_key":"sentinel-value","dictionary":["from-the-old-file"]}"#;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("o8-voice-polish-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // The host's secrets file sits beside it; nothing here may touch it.
    std::fs::write(dir.join("dictation.json"), SENTINEL).unwrap();
    dir
}

fn on_disk(dir: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join("voice-prefs.json")).unwrap()).unwrap()
}

/// Clicks a control, first scrolling it fully into the settings viewport:
/// the Instructions card sits below the fold in the test window.
fn tap(cx: &mut VisualTestContext, selector: &str) {
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    draw(cx);
    let mut bounds = None;
    for _ in 0..30 {
        let target = cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("missing {selector}"));
        let viewport = cx
            .debug_bounds("settings-scroll")
            .expect("settings scroll viewport");
        if target.top() >= viewport.top() && target.bottom() <= viewport.bottom() {
            bounds = Some(target);
            break;
        }
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: viewport.center(),
            delta: gpui::ScrollDelta::Pixels(gpui::point(
                gpui::px(0.),
                gpui::px(if target.bottom() > viewport.bottom() {
                    -200.
                } else {
                    200.
                }),
            )),
            ..Default::default()
        });
        draw(cx);
    }
    let bounds = bounds.unwrap_or_else(|| panic!("{selector} must scroll into view"));
    cx.simulate_click(bounds.center(), Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    // Blur listeners run during the draw; let the save they start finish.
    cx.run_until_parked();
    draw(cx);
}

fn type_into(cx: &mut VisualTestContext, selector: &str, text: &str) {
    tap(cx, selector);
    cx.simulate_input(text);
    cx.run_until_parked();
    draw(cx);
}

fn open_polish<'a>(
    dir: &Path,
    cx: &'a mut TestAppContext,
) -> (Peer, Entity<Settings>, &'a mut VisualTestContext) {
    let peer = Peer::new();
    let (view, cx) = open(&peer, cx);
    // Blur is reported only for an active window, as the real Settings window is.
    cx.update(|window, _| window.activate_window());
    wait(&view, cx, |_| true);
    let path = dir.join("voice-prefs.json");
    view.update_in(cx, |s, window, cx| {
        s.voice_polish = Some(cx.new(|cx| VoicePolish::new(Some(path), window, cx)));
    });
    click(cx, "settings-nav-voice");
    wait(&view, cx, |s| s.section == "voice");
    click(cx, "settings-voice-tab-polish");
    wait(&view, cx, |s| s.voice_panel == VoicePanel::Polish);
    (peer, view, cx)
}

fn untouched(dir: &Path) {
    assert_eq!(
        std::fs::read_to_string(dir.join("dictation.json")).unwrap(),
        SENTINEL,
        "the host's secrets file is never read into or written"
    );
}

#[gpui::test]
fn settings_voice_polish_edits_words_snippets_and_instructions(cx: &mut TestAppContext) {
    let dir = scratch("flow");
    std::fs::write(
        dir.join("voice-prefs.json"),
        r#"{"dictionary":["Kubernetes"],"sounds_enabled":false,"not_on_the_list":1}"#,
    )
    .unwrap();
    let (_peer, view, cx) = open_polish(&dir, cx);
    assert!(cx.debug_bounds("settings-voice-polish-word-0").is_some());

    // Words: Enter adds; a different case of an existing word doesn't.
    type_into(cx, "settings-voice-polish-word-input", "o8");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(on_disk(&dir)["dictionary"], json!(["Kubernetes", "o8"]));
    type_into(cx, "settings-voice-polish-word-input", "KUBERNETES");
    tap(cx, "settings-voice-polish-word-add");
    assert_eq!(on_disk(&dir)["dictionary"], json!(["Kubernetes", "o8"]));
    // A word the host added since the last read survives the next change.
    let mut file = on_disk(&dir);
    file["dictionary"] = json!(["Kubernetes", "o8", "Symon"]);
    std::fs::write(dir.join("voice-prefs.json"), file.to_string()).unwrap();
    tap(cx, "settings-voice-polish-word-remove-0");
    assert_eq!(on_disk(&dir)["dictionary"], json!(["o8", "Symon"]));

    // Snippets: Enter in the replacement adds; the same trigger in any case replaces.
    type_into(cx, "settings-voice-polish-trigger-input", "brb");
    type_into(
        cx,
        "settings-voice-polish-replacement-input",
        "be right back",
    );
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(
        on_disk(&dir)["replacements"],
        json!([{"trigger":"brb","replacement":"be right back"}])
    );
    type_into(cx, "settings-voice-polish-trigger-input", "BRB");
    type_into(cx, "settings-voice-polish-replacement-input", "back soon");
    tap(cx, "settings-voice-polish-snippet-add");
    assert_eq!(
        on_disk(&dir)["replacements"],
        json!([{"trigger":"BRB","replacement":"back soon"}])
    );
    draw(cx);
    assert!(cx.debug_bounds("settings-voice-polish-snippet-0").is_some());
    tap(cx, "settings-voice-polish-snippet-remove-0");
    assert_eq!(on_disk(&dir)["replacements"], json!([]));

    // Instructions save trimmed when the field is left.
    type_into(
        cx,
        "settings-voice-polish-instructions",
        "  Keep my casual tone  ",
    );
    view.read_with(cx, |s, cx| {
        let polish = s.voice_polish.as_ref().unwrap().read(cx);
        assert_eq!(
            polish.instructions.read(cx).text,
            "  Keep my casual tone  ",
            "typing reaches the Instructions field"
        );
    });
    assert!(
        on_disk(&dir).get("polish_instructions").is_none(),
        "not saved while typing"
    );
    tap(cx, "settings-voice-polish-word-input");
    assert_eq!(on_disk(&dir)["polish_instructions"], "Keep my casual tone");

    // Everything else is as the host left it, and the file stays private.
    let file = on_disk(&dir);
    assert_eq!(file["sounds_enabled"], false);
    assert_eq!(file["not_on_the_list"], 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("voice-prefs.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names.len(),
        2,
        "only the two files, no temp left: {names:?}"
    );
    untouched(&dir);
}

#[gpui::test]
fn settings_voice_polish_waits_for_the_host_file(cx: &mut TestAppContext) {
    let dir = scratch("missing");
    let (_peer, view, cx) = open_polish(&dir, cx);
    assert!(
        cx.debug_bounds("settings-voice-polish-unavailable")
            .is_some()
    );
    assert!(
        cx.debug_bounds("settings-voice-polish-word-input")
            .is_none()
    );
    view.read_with(cx, |s, cx| {
        assert_eq!(
            s.voice_polish.as_ref().unwrap().read(cx).prefs,
            Some(crate::shell::settings::voice_prefs::Prefs::Missing)
        )
    });
    assert!(!dir.join("voice-prefs.json").exists(), "never created");
    untouched(&dir);
}

#[gpui::test]
fn settings_voice_polish_leaves_an_unreadable_file(cx: &mut TestAppContext) {
    let dir = scratch("unreadable");
    std::fs::write(dir.join("voice-prefs.json"), "[not an object]").unwrap();
    let (_peer, _view, cx) = open_polish(&dir, cx);
    assert!(
        cx.debug_bounds("settings-voice-polish-unavailable")
            .is_some()
    );
    assert!(
        cx.debug_bounds("settings-voice-polish-word-input")
            .is_none()
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("voice-prefs.json")).unwrap(),
        "[not an object]"
    );
    untouched(&dir);
}
