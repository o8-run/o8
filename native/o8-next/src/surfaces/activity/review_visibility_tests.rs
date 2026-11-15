//! Non-rejections never create an original-author correction control.
use super::*;
use gpui::TestAppContext;

#[gpui::test]
fn activity_request_changes_requires_saved_rejection(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (pane, cx) = cx.add_window_view(|_, cx| ActivityPane::new(client, "/fixture".into(), cx));
    cx.run_until_parked();
    pane.update(cx, |pane, cx| {
        for review in [
            Value::Null,
            json!({"approved":true,"auditApprovalId":"approved"}),
            json!({"approved":false}),
        ] {
            let row = Row {
                kind: "packet",
                id: "verdict".into(),
                repo: None,
                repo_identity: "local".into(),
                title: "Verdict fixture".into(),
                date: String::new(),
                ci: vec![],
                data: json!({"review":review}),
            };
            let read = packet::Review::default();
            pane.packet_review(&row, &read, cx);
            assert!(!pane.packet.corrections.contains_key(&row.id));
        }
    });
}
