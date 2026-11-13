//! Scope changes cancel local confirmations without sending recovery commands.
use super::*;
use gpui::TestAppContext;

#[gpui::test]
fn recovery_scope_change_cancels_destructive_confirmations(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|_, cx| ActivityPane::new(client, "/fixture".into(), cx));
    cx.run_until_parked();
    let packet = Row {
        kind: "packet",
        id: "scope-packet".into(),
        repo: None,
        repo_identity: "local".into(),
        title: "Scope fixture".into(),
        date: String::new(),
        ci: vec![],
        data: json!({"id":"scope-packet","status":"failed"}),
    };
    for kind in [
        recovery::Kind::Reset,
        recovery::Kind::StopReset,
        recovery::Kind::StartOver,
    ] {
        view.update(cx, |view, cx| {
            view.act(Action::Recovery(packet.clone(), kind), cx);
            assert!(view.packet.recovery.ask.is_some());
            view.closing = Some(packet.id.clone());
            view.archiving = Some(packet.id.clone());
            view.act(Action::Scope("/other-fixture".into()), cx);
            assert!(
                view.packet.recovery.ask.is_none(),
                "scope change must cancel recovery confirmation"
            );
            assert!(view.closing.is_none());
            assert!(view.archiving.is_none());
            view.act(Action::Scope("/fixture".into()), cx);
            view.act(Action::RecoveryConfirm(packet.clone()), cx);
            assert!(
                !view.pending,
                "returning to the packet must not revive a confirmation"
            );
        });
        cx.run_until_parked();
    }
}

#[gpui::test]
fn recovery_confirmation_clears_when_packet_becomes_ineligible(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|_, cx| ActivityPane::new(client, "/fixture".into(), cx));
    cx.run_until_parked();
    for change in [
        json!({"archivedAt":"2026-11-12"}),
        json!({"status":"queued"}),
        json!({"lane":null}),
    ] {
        view.update(cx, |view, cx| {
            let mut row = Row {
                kind: "packet",
                id: "recovery-fixture".into(),
                repo: None,
                repo_identity: "local".into(),
                title: "Recovery fixture".into(),
                date: String::new(),
                ci: vec![],
                data: json!({"status":"blocked","lane":{"laneId":"fixture-lane"}}),
            };
            view.act(Action::Recovery(row.clone(), recovery::Kind::Reset), cx);
            assert!(view.packet.recovery.ask.is_some());
            for (key, value) in change.as_object().unwrap() {
                row.data[key] = value.clone();
            }
            let _ = view.recovery_confirmation(&row, cx);
            assert!(
                view.packet.recovery.ask.is_none(),
                "ineligible row must cancel confirmation"
            );
            view.act(Action::RecoveryConfirm(row), cx);
            assert!(!view.pending, "stale confirmation must not send a reset");
        });
    }
}
