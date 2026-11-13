//! Direct headless rendering and local recovery; no simulated input.
use super::*;
use gpui::TestAppContext;

#[gpui::test]
fn request_changes_hides_non_rejections(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|_, cx| RequestChanges::new(client, "verdict".into(), cx));
    cx.run_until_parked();
    for reason in [
        "This saved review is approved.",
        "No saved review is available for this packet.",
    ] {
        view.update(cx, |view, cx| {
            view.availability = json!({"available":false,"savedRejection":false,"reason":reason});
            view.notice.clear();
            assert!(
                !view.visible(),
                "approved and pending reviews must not offer Request changes"
            );
            assert!(!view.outcome().contains("Start over"));
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("request-changes").is_none());
        assert!(cx.debug_bounds("request-changes-open").is_none());
    }
}

#[gpui::test]
fn request_changes_recovery_pointer_requires_unavailable_author(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|_, cx| RequestChanges::new(client, "rejected".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, _| {
        view.notice.clear();
        view.availability = json!({"available":false,"savedRejection":true,
            "authorUnavailable":false,"reason":"The correction budget is exhausted."});
        assert!(
            !view.outcome().contains("Start over"),
            "a policy refusal must not recommend discarding work"
        );
        view.availability["authorUnavailable"] = json!(true);
        assert!(view.outcome().contains("Start over with feedback"));
    });
}

#[gpui::test]
fn request_changes_discards_local_retry_and_keeps_note_while_server_is_down(
    cx: &mut TestAppContext,
) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|_, cx| RequestChanges::new(client, "rejected".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        // A previously read saved rejection, followed by a transport failure.
        view.known_rejection = true;
        view.availability = json!({"savedRejection":true,"available":true,
            "repoPath":"/fixture","threadId":"parent","review":{"packetId":"rejected"}});
        view.input.update(cx, |input, cx| {
            input.set_text("Preserve the public API", cx)
        });
    });
    cx.update(|window, cx| view.update(cx, |view, cx| view.open(window, cx)));
    view.update(cx, |view, cx| view.send(cx));
    cx.run_until_parked();
    let original = view.read_with(cx, |view, _| {
        assert!(!view.busy);
        assert!(view.failed);
        view.pending
            .clone()
            .expect("a transport failure retains the retry body")
    });
    assert!(cx.debug_bounds("request-changes-discard").is_some());
    view.update(cx, |view, cx| view.send(cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.pending.as_ref(), Some(&original))
    });
    cx.update(|window, cx| view.update(cx, |view, cx| view.discard_and_recheck(window, cx)));
    cx.run_until_parked();
    view.read_with(cx, |view, cx| {
        assert!(!view.busy && !view.loading);
        assert!(view.pending.is_none());
        assert_eq!(view.input.read(cx).text, "Preserve the public API");
        assert!(view.visible() && view.failed);
        assert!(
            !view.enabled(),
            "a failed re-check must not allow a fresh send"
        );
    });
    assert!(cx.debug_bounds("request-changes-note-readonly").is_none());
    assert!(cx.debug_bounds("request-changes-refresh").is_some());
}
