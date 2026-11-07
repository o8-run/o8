//! Real clicks -> Settings › Voice › History -> the recorder's file on disk.
//! Every test uses its own scratch file; none reads this Mac's history.
use super::*;
use crate::settings::test_peer::*;
use crate::shell::settings::voice_history::VoiceHistory;
use gpui::{Modifiers, TestAppContext, VisualTestContext};
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("o8-voice-history-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("dictation-history.json")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn on_disk(path: &PathBuf) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn ids(view: &Entity<Settings>, cx: &mut VisualTestContext) -> Vec<String> {
    view.read_with(cx, |s, cx| {
        s.voice_history
            .as_ref()
            .unwrap()
            .read(cx)
            .entries
            .iter()
            .map(|e| e.id.clone())
            .collect()
    })
}

fn tap(cx: &mut VisualTestContext, selector: &str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {selector}"));
    cx.simulate_click(bounds.center(), Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

fn clipboard(cx: &mut VisualTestContext) -> Option<String> {
    cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
}

fn open_history(
    path: PathBuf,
    cx: &mut TestAppContext,
) -> (Peer, Entity<Settings>, &mut VisualTestContext) {
    let peer = Peer::new();
    let (view, cx) = open(&peer, cx);
    wait(&view, cx, |_| true);
    view.update_in(cx, |s, window, cx| {
        s.voice_history = Some(cx.new(|cx| VoiceHistory::new(Some(path), window, cx)));
    });
    click(cx, "settings-nav-voice");
    wait(&view, cx, |s| s.section == "voice");
    (peer, view, cx)
}

#[gpui::test]
fn settings_voice_history_lists_copies_deletes_and_clears(cx: &mut TestAppContext) {
    let path = scratch("flow");
    let now = now();
    // Oldest first, as the recorder appends. The unknown field must survive a rewrite.
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&json!([
            {"id":"1","ts":now - 7200,"mode":"dictation","text":"Draft the launch note","app":"com.apple.Notes","extra":"kept"},
            {"id":"2","ts":now - 300,"mode":"ask","text":"What changed in the build today?","app":""},
            {"id":"3","ts":now - 10,"mode":"dictation","text":"   ","app":"com.apple.mail"}
        ]))
        .unwrap(),
    )
    .unwrap();
    let (_peer, view, cx) = open_history(path.clone(), cx);

    // Voice opens on its fields, with the text-only pointer to the voice window.
    assert!(cx.debug_bounds("settings-voice-window-hint").is_some());
    assert!(cx.debug_bounds("settings-voice-history").is_none());
    click(cx, "settings-voice-tab-history");
    wait(&view, cx, |s| s.voice_panel == VoicePanel::History);
    assert!(cx.debug_bounds("settings-voice-history").is_some());
    assert!(cx.debug_bounds("settings-voice-window-hint").is_some());
    assert_eq!(ids(&view, cx), ["3", "2", "1"], "newest first");
    let mode = cx.debug_bounds("settings-voice-history-mode-1").unwrap();
    let time = cx.debug_bounds("settings-voice-history-time-1").unwrap();
    assert!(
        time.left() - mode.right() >= gpui::px(8.),
        "label and time keep their gap"
    );

    // Copy puts exactly the entry's text on the clipboard; blank text copies nothing.
    tap(cx, "settings-voice-history-copy-1");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some("What changed in the build today?")
    );
    tap(cx, "settings-voice-history-copy-0");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some("What changed in the build today?")
    );

    // A dictation recorded after the list loaded survives a delete.
    let mut file = on_disk(&path);
    file.as_array_mut()
        .unwrap()
        .push(json!({"id":"4","ts":now,"mode":"dictation","text":"Recorded meanwhile","app":""}));
    std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap()).unwrap();
    tap(cx, "settings-voice-history-delete-1");
    let file = on_disk(&path);
    let kept: Vec<&str> = file
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(kept, ["1", "3", "4"], "only the chosen entry goes");
    assert_eq!(file[0]["extra"], "kept");
    assert_eq!(ids(&view, cx), ["4", "3", "1"]);

    tap(cx, "settings-voice-history-clear");
    assert_eq!(on_disk(&path), json!([]));
    assert!(ids(&view, cx).is_empty());
    assert!(cx.debug_bounds("settings-voice-history-empty").is_some());
    assert!(cx.debug_bounds("settings-voice-history-clear").is_none());

    // Leaving Voice and coming back opens on its fields again.
    click(cx, "settings-nav-general");
    wait(&view, cx, |s| s.section == "general");
    click(cx, "settings-nav-voice");
    wait(&view, cx, |s| s.section == "voice");
    assert!(view.read_with(cx, |s, _| s.voice_panel == VoicePanel::Attention));
}

#[gpui::test]
fn settings_voice_history_opens_from_the_voice_flyout(cx: &mut TestAppContext) {
    let path = scratch("flyout");
    std::fs::write(
        &path,
        r#"[{"id":"1","ts":1,"mode":"dictation","text":"Hello","app":""}]"#,
    )
    .unwrap();
    let (_peer, view, cx) = open_history(path, cx);
    click(cx, "settings-nav-general");
    wait(&view, cx, |s| s.section == "general");
    tap(cx, "settings-nav-more-voice");
    let last = nav_groups::groups_of("voice").len() - 1;
    assert_eq!(nav_groups::groups_of("voice")[last], "History");
    tap(cx, &format!("settings-nav-group-voice-{last}"));
    wait(&view, cx, |s| {
        s.section == "voice" && s.voice_panel == VoicePanel::History
    });
    assert_eq!(ids(&view, cx), ["1"]);
}

#[gpui::test]
fn settings_voice_history_leaves_a_file_it_cannot_read(cx: &mut TestAppContext) {
    let path = scratch("malformed");
    std::fs::write(&path, "{not json").unwrap();
    let (_peer, view, cx) = open_history(path.clone(), cx);
    click(cx, "settings-voice-tab-history");
    wait(&view, cx, |s| s.voice_panel == VoicePanel::History);
    assert!(cx.debug_bounds("settings-voice-history-empty").is_some());
    assert!(cx.debug_bounds("settings-voice-history-clear").is_none());
    tap(cx, "settings-voice-history-refresh");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
}

#[gpui::test]
fn settings_voice_history_jump_while_busy_repaints_and_reads(cx: &mut TestAppContext) {
    let path = scratch("busy");
    std::fs::write(
        &path,
        r#"[{"id":"1","ts":1,"mode":"dictation","text":"Hello","app":""}]"#,
    )
    .unwrap();
    let (_peer, view, cx) = open_history(path, cx);
    // A save in flight: the section can't change, but Voice's own parts can.
    let before = view.update(cx, |s, _| {
        s.busy = true;
        s.revision
    });
    view.update_in(cx, |s, window, cx| {
        s.jump_to_group("voice", nav_groups::VOICE_HISTORY, window, cx)
    });
    cx.run_until_parked();
    view.read_with(cx, |s, _| {
        assert_eq!(s.voice_panel, VoicePanel::History);
        assert!(s.revision > before, "the switch must repaint Settings");
    });
    assert_eq!(ids(&view, cx), ["1"], "showing History reads its file");
    view.update(cx, |s, _| s.busy = false);
}

#[gpui::test]
fn settings_voice_history_reads_on_activation_only_while_shown(cx: &mut TestAppContext) {
    let path = scratch("activation");
    let write = |text: &str| {
        std::fs::write(
            &path,
            format!(r#"[{{"id":"1","ts":1,"mode":"dictation","text":"{text}","app":""}}]"#),
        )
        .unwrap()
    };
    write("First");
    let (_peer, view, cx) = open_history(path.clone(), cx);
    let text = |view: &Entity<Settings>, cx: &mut VisualTestContext| {
        view.read_with(cx, |s, cx| {
            s.voice_history
                .as_ref()
                .unwrap()
                .read(cx)
                .entries
                .first()
                .map(|e| e.text.clone())
        })
    };
    let refocus = |cx: &mut VisualTestContext| {
        cx.deactivate_window();
        cx.update(|window, _| window.activate_window());
        cx.run_until_parked();
    };
    // On Voice's fields, coming forward reads nothing.
    refocus(cx);
    assert_eq!(text(&view, cx), None);
    click(cx, "settings-voice-tab-history");
    wait(&view, cx, |s| s.voice_panel == VoicePanel::History);
    assert_eq!(text(&view, cx).as_deref(), Some("First"));
    // On screen, coming forward rereads.
    write("Second");
    refocus(cx);
    assert_eq!(text(&view, cx).as_deref(), Some("Second"));
    // Off screen again, it doesn't.
    click(cx, "settings-voice-tab-attention");
    wait(&view, cx, |s| s.voice_panel == VoicePanel::Attention);
    write("Third");
    refocus(cx);
    assert_eq!(text(&view, cx).as_deref(), Some("Second"));
}
