use super::*;
use gpui::TestAppContext;

#[gpui::test]
fn packet_merge_control_requires_approved_review(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:9", Some("fixture".into())).unwrap();
    let (pane, cx) = cx.add_window_view(|_, cx| ActivityPane::new(client, "/fixture".into(), cx));
    cx.run_until_parked();
    pane.update(cx, |pane, cx| {
        for approved in [false, true] {
            let row = Row {
                kind: "packet",
                id: "merge-visibility".into(),
                repo: None,
                repo_identity: "local".into(),
                title: "Review".into(),
                date: String::new(),
                ci: vec![],
                data: json!({"status":"awaiting_review","lane":{"laneId":"fixture"},
                    "review":{"approved":approved}}),
            };
            pane.controls.clear();
            let _ = pane.packet_controls(&row, div().into_any_element(), cx);
            assert_eq!(
                pane.controls.iter().any(|(id, _)| id == "activity-lane-merge"),
                approved
            );
        }
    });
}
