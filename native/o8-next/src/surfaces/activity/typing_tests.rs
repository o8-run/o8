use super::*;
use gpui::TestAppContext;

/// Calls the pane handler directly in GPUI's test platform. No window-system input.
#[gpui::test]
fn activity_request_changes_typing_guard(cx: &mut TestAppContext) {
    use crate::{client::Client, request_changes::RequestChanges};
    use gpui::{AppContext, KeyDownEvent, Keystroke};

    let client = Client::authenticated("http://127.0.0.1:1", Some("fixture".into())).unwrap();
    let (pane, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(client.clone(), String::new(), cx));
    let control = cx.new(|cx| RequestChanges::new(client, "typing-fixture".into(), cx));
    cx.run_until_parked();
    cx.update(|window, cx| {
        control.update(cx, |control, cx| control.open_note_for_test(window, cx));
        assert!(control.read(cx).editing(window, cx));
        pane.update(cx, |pane, cx| {
            pane.packet
                .corrections
                .insert("typing-fixture".into(), control.clone());
            for key in ["space", "enter"] {
                pane.attention_open = false;
                pane.controls = vec![("typing-probe".into(), Action::Attention)];
                pane.keyboard = Some("typing-probe".into());
                pane.key_down(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                    },
                    window,
                    cx,
                );
                assert!(
                    !pane.attention_open,
                    "Typing {key} must not activate the Activity selection"
                );
            }
            pane.focus.focus(window);
            pane.key_down(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("space").unwrap(),
                    is_held: false,
                },
                window,
                cx,
            );
            assert!(
                pane.attention_open,
                "The same Activity action works outside the note"
            );
        });
    });
}
